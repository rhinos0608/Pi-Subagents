/**
 * Child tool plan: which builtin tools, MCP tools, runtime hooks, and extension
 * files a child launch gets, and how that resolution is reported. Both the
 * foreground path and the async runner build their session launch from this.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	formatUnresolvedMcpDirectToolSelectors,
	resolveMcpDirectToolResolution,
	type McpRuntimeSnapshotHost,
	type ResolvedMcpDirectToolSelection,
} from "./mcp-direct-tool-allowlist.ts";
import {
	TEMP_ROOT_DIR,
	type JsonSchemaObject,
	type LaunchResolvedChildExtensions,
} from "../../shared/types.ts";
import { THINKING_LEVELS } from "../../shared/model-info.ts";
import { getAgentDir } from "../../shared/utils.ts";
import type { PermissionRules } from "./permissions.ts";
import { snapshotRequiredChildExtensions, type RequiredChildExtensionSnapshot } from "../../shared/required-child-extensions.ts";
import {
	capabilityCeilingAgentRestrictionSources,
	intersectSubagentCapabilityCeilings,
	isAgentAllowedByCapabilityCeiling,
	type ResolvedSubagentCapabilityCeiling,
	type SubagentCapabilityAudit,
} from "./capability-ceiling.ts";

const MAX_LAUNCH_RESOLVED_EXTENSION_IDS = 32;
const PROMPT_RUNTIME_EXTENSION_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"subagent-prompt-runtime.ts",
);
const FANOUT_CHILD_EXTENSION_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"extension",
	"fanout-child.ts",
);
const FAST_MODE_EXTENSION_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fast-mode-extension.ts",
);
const SUBAGENT_RUNTIME_EXTENSION_PATHS = new Set([
	PROMPT_RUNTIME_EXTENSION_PATH,
	FANOUT_CHILD_EXTENSION_PATH,
	FAST_MODE_EXTENSION_PATH,
].map((extensionPath) => path.normalize(extensionPath)));

/** True for the extension files pi-subagents itself installs in child sessions. */
export function isSubagentRuntimeExtensionPath(extensionPath: string): boolean {
	return SUBAGENT_RUNTIME_EXTENSION_PATHS.has(path.normalize(extensionPath));
}
const FAST_MODE_ALLOWED_MODELS = new Set([
	"openai-codex/gpt-5.6-luna",
	"openai-codex/gpt-5.6-sol",
]);
const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const PI_BUILTIN_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
/** Native coordination tools the plan recognizes regardless of host availability. */
const NATIVE_CHILD_TOOL_NAMES = new Set(["subagent", "contact_supervisor", "intercom", "subagent_supervisor", "bg_wait", "structured_output"]);
const REPOSITORY_INSPECTION_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "powershell"]);
const REVIEW_OR_SCOUT_AGENT_PATTERN = /\b(?:reviewer|scout)\b/i;

export function isReviewOrScoutLaneAgent(agentName: string | undefined): boolean {
	return typeof agentName === "string" && REVIEW_OR_SCOUT_AGENT_PATTERN.test(agentName);
}

/** Internal tool name plus its human-readable display label (Pi `registerTool({ name, label })`). */
export interface HostToolIdentity {
	name: string;
	label?: string;
}

/** Extract `{ name, label }` identities from a Pi host for label-aware allowlists. */
export function getHostAvailableTools(pi: Pick<ExtensionAPI, "getAllTools">): HostToolIdentity[] {
	try {
		const tools = pi.getAllTools();
		if (!Array.isArray(tools)) return [];
		const identities: HostToolIdentity[] = [];
		for (const tool of tools) {
			const name = (tool as { name?: unknown }).name;
			if (typeof name !== "string" || !name) continue;
			const label = (tool as { label?: unknown }).label;
		identities.push(label !== undefined && typeof label === "string" && label ? { name, label } : { name });
		}
		return identities;
	} catch {
		return [];
	}
}

function lowered(value: string): string {
	return value.toLowerCase();
}

/**
 * Resolve one allowlist entry to its internal tool name. Exact names win,
 * then an unambiguous exact display label, then an unambiguous
 * case-insensitive name/label match (covers `Browser` for `browser`).
 * Ambiguous or unknown entries pass through unchanged for child-startup
 * validation — never silently select one of several matches.
 */
export function canonicalizeChildToolEntry(entry: string, known: readonly HostToolIdentity[]): string {
	for (const identity of known) if (identity.name === entry) return identity.name;
	const labelMatches = known.filter((identity) => identity.label === entry);
	if (labelMatches.length === 1) return (labelMatches[0] as HostToolIdentity).name;
	if (labelMatches.length > 1) return entry;
	const want = lowered(entry);
	let match: string | undefined;
	for (const identity of known) {
		if (lowered(identity.name) !== want && (identity.label === undefined || lowered(identity.label) !== want)) continue;
		if (match !== undefined && match !== identity.name) return entry;
		match = identity.name;
	}
	return match ?? entry;
}

/** Case-insensitive tool-name equality for allowlist comparisons. */
export function childToolNamesEqual(a: string, b: string): boolean {
	return a === b || lowered(a) === lowered(b);
}

/** An entry plus its lowercase variant so Pi's name-strict allowlist activates either spelling. */
export function withChildToolCaseVariants(entries: readonly string[]): string[] {
	const expanded: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		for (const variant of entry.toLowerCase() === entry ? [entry] : [entry, entry.toLowerCase()]) {
			if (seen.has(variant)) continue;
			seen.add(variant);
			expanded.push(variant);
		}
	}
	return expanded;
}

export function missingPermittedRepositoryInspectionTools(
	unavailableHostBuiltins: readonly string[],
	excludeTools: readonly string[] = [],
): string[] {
	const excluded = new Set(excludeTools);
	return unavailableHostBuiltins.filter((tool) => REPOSITORY_INSPECTION_TOOLS.has(tool) && !excluded.has(tool));
}

export function formatReviewLaneToolContractFailure(input: {
	agentName?: string;
	missingTools: readonly string[];
	requestedTools?: readonly string[];
	effectiveTools: readonly string[];
	ceilingSources?: readonly string[];
	excludeTools?: readonly string[];
}): string {
	const subject = input.agentName ? `Agent '${input.agentName}'` : "Subagent";
	return [
		`${subject}: tool contract could not be satisfied; host runtime does not provide permitted required repository tools [${input.missingTools.join(", ")}].`,
		`Requested tool names: ${input.requestedTools ? `[${input.requestedTools.join(", ")}]` : "not explicitly specified"}; effective tool allowlist: [${input.effectiveTools.join(", ")}].`,
		...(input.ceilingSources?.length ? [`Active capability ceiling sources: [${input.ceilingSources.join(", ")}].`] : []),
		...(input.excludeTools?.length ? [`Explicit excludeTools: [${input.excludeTools.join(", ")}].`] : []),
		"This is a lane infrastructure failure, not a completed review/scout result.",
	].join(" ");
}

export function deriveForkPromptCacheKey(parentSessionId: string | undefined): string | undefined {
	const parent = parentSessionId?.trim();
	if (!parent) return undefined;
	const digest = createHash("sha256").update(parent).digest("hex").slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH - "pi-fork:".length);
	return `pi-fork:${digest}`;
}

function sanitizeSupervisorChannelSegment(value: string): string {
	return (
		value
			.trim()
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "unknown"
	);
}

export function supervisorChannelDir(
	runId: string,
	agent: string,
	childIndex: number,
): string {
	return path.join(
		TEMP_ROOT_DIR,
		"supervisor-channels",
		`${sanitizeSupervisorChannelSegment(runId)}-${sanitizeSupervisorChannelSegment(agent)}-${childIndex}`,
	);
}

export function applyThinkingSuffix(
	model: string | undefined,
	thinking: string | false | undefined,
	replaceExisting = false,
): string | undefined {
	if (!model || !thinking) return model;
	const colonIdx = model.lastIndexOf(":");
	if (
		colonIdx !== -1 &&
		THINKING_LEVELS.some((level) => level === model.substring(colonIdx + 1))
	) {
		return replaceExisting ? `${model.slice(0, colonIdx)}:${thinking}` : model;
	}
	return `${model}:${thinking}`;
}

function stripThinkingSuffix(model: string): string {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return model;
	return THINKING_LEVELS.some((level) => level === model.substring(colonIdx + 1))
		? model.slice(0, colonIdx)
		: model;
}

function resolveFastModeExtension(input: Pick<ResolvePiLaunchToolPlanInput, "fast" | "model" | "modelCandidates" | "agentName">): string[] {
	if (!input.fast) return [];
	const candidates = (input.modelCandidates?.length ? input.modelCandidates : input.model ? [input.model] : [])
		.map(stripThinkingSuffix);
	if (candidates.length === 0) {
		throw new Error(`fast mode requires an explicit supported native OpenAI-Codex model${input.agentName ? ` for agent '${input.agentName}'` : ""}.`);
	}
	const unsupported = candidates.filter((model) => !FAST_MODE_ALLOWED_MODELS.has(model));
	if (unsupported.length > 0) {
		throw new Error(`fast mode supports only ${[...FAST_MODE_ALLOWED_MODELS].join(", ")}; unsupported model${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.`);
	}
	return [FAST_MODE_EXTENSION_PATH];
}

export interface ResolvePiLaunchToolPlanInput {
	tools?: string[];
	excludeTools?: string[];
	allowNestedSubagents?: boolean;
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	requiredExtensions?: RequiredChildExtensionSnapshot;
	mcpDirectTools?: string[];
	cwd?: string;
	requireReadTool?: boolean;
	structuredOutput?:
		| boolean
		| {
				schema: JsonSchemaObject;
				schemaPath: string;
				outputPath: string;
		  };
	fast?: boolean;
	model?: string;
	modelCandidates?: readonly string[];
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	inheritedCapabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	agentName?: string;
	permissionRules?: PermissionRules;
	runtimeSnapshotHost?: McpRuntimeSnapshotHost;
	/**
	 * When provided, child tool plans intersect known Pi core tool slots with
	 * this set. Core tools the agent declares but the host does not provide are
	 * omitted with a non-fatal warning (tracked in `unavailableHostBuiltins`).
	 * Review/scout lanes fail closed when a requested, still-permitted
	 * repository inspection tool is among those host omissions. Intentionally
	 * empty or ceiling-restricted allowlists are not a minimum-tool contract.
	 * Non-core names remain allowed and are validated in the child's registry.
	 */
	hostAvailableBuiltins?: readonly string[];
	/**
	 * `{ name, label }` identities from the host registry. Display labels in
	 * `tools`/`excludeTools` resolve to their internal name; without it only
	 * exact and case-insensitive name matches resolve and other entries pass
	 * through for child-startup validation.
	 */
	hostAvailableTools?: readonly HostToolIdentity[];
}

export interface PiLaunchToolPlan {
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	requestedBuiltinTools: string[];
	declaredBuiltinTools: string[];
	excludeTools: string[];
	toolExtensionPaths: string[];
	resolvedMcpSelections: ResolvedMcpDirectToolSelection[];
	effectiveMcpSelections: ResolvedMcpDirectToolSelection[];
	effectiveMcpTools: string[];
	explicitToolAllowlist: boolean;
	internalTools: string[];
	effectiveToolAllowlist: string[];
	requiredChildTools: string[];
	fanoutAuthorized: boolean;
	runtimeExtensions: string[];
	configuredExtensions: string[];
	requiredExtensions: RequiredChildExtensionSnapshot;
	extensionArgs: string[];
	disableAmbientExtensions: boolean;
	capabilityAudit?: SubagentCapabilityAudit;
	/** Non-fatal launch warnings; they do not change behavior. */
	warnings: string[];
	/** Builtin tools the agent declared but the host runtime does not provide. */
	unavailableHostBuiltins: string[];
}

function extensionIdentifier(value: string): string {
	return `sha256:${createHash("sha256").update(path.normalize(value.trim())).digest("hex").slice(0, 16)}`;
}

function boundedExtensionIdentifiers(values: string[]): {
	ids: string[];
	omitted: number;
} {
	const ids = [...new Set(values.map(extensionIdentifier))];
	return {
		ids: ids.slice(0, MAX_LAUNCH_RESOLVED_EXTENSION_IDS),
		omitted: Math.max(0, ids.length - MAX_LAUNCH_RESOLVED_EXTENSION_IDS),
	};
}

function hasPermissionRules(rules: PermissionRules | undefined): boolean {
	return rules !== undefined && Object.keys(rules).length > 0;
}

/**
 * Children are pi sessions inside the parent or the runner process; a spawned
 * `pi` received extra MCP server definitions as a CLI argument, but a session
 * has no such input. Selecting a server that exists only in pi-mcp-adapter's
 * runtime snapshot therefore cannot work and fails the launch.
 */
export function formatRuntimeSnapshotMcpServersError(agentName: string | undefined, serverNames: readonly string[]): string {
	const subject = agentName ? `Agent '${agentName}'` : "Subagent";
	return `${subject} selects MCP tools from servers that exist only in pi-mcp-adapter's runtime snapshot (${serverNames.join(", ")}). MCP servers from the runtime snapshot cannot be provided to in-process children; MCP tools must come from an ambient adapter extension in a background child (\`async: true\`), so add the server to the adapter's configuration file instead.`;
}

export function projectLaunchResolvedChildExtensions(
	toolPlan: Pick<
		PiLaunchToolPlan,
		| "runtimeExtensions"
		| "configuredExtensions"
		| "requiredExtensions"
		| "extensionArgs"
		| "disableAmbientExtensions"
	>,
): LaunchResolvedChildExtensions {
	const runtime = boundedExtensionIdentifiers(toolPlan.runtimeExtensions);
	const configured = boundedExtensionIdentifiers(toolPlan.configuredExtensions);
	const effective = boundedExtensionIdentifiers(toolPlan.extensionArgs);
	return {
		version: 1,
		source: "launch-resolved",
		disableAmbientExtensions: toolPlan.disableAmbientExtensions,
		runtime: runtime.ids,
		configured: configured.ids,
		required: toolPlan.requiredExtensions.map(({ id }) => id),
		effective: effective.ids,
		omitted: {
			runtime: runtime.omitted,
			configured: configured.omitted,
			required: 0,
			effective: effective.omitted,
		},
	};
}

/**
 * Resolve the permission-system extension entry point when installed.
 * Returns the absolute path to the extension's main module, or undefined
 * when the package is not installed. Callers can check `autoInject` config
 * to decide whether to include it in child sessions.
 */
export function resolvePermissionSystemExtension(): string | undefined {
	const agentDir = getAgentDir();
	const candidates = [
		// npm-scoped package (most common)
		path.join(
			agentDir,
			"npm",
			"node_modules",
			"@gotgenes",
			"pi-permission-system",
		),
		// direct extension directory (some layouts)
		path.join(agentDir, "extensions", "pi-permission-system"),
	];
	const errors: Error[] = [];
	for (const extDir of candidates) {
		if (!fs.existsSync(extDir)) continue;
		const pkgPath = path.join(extDir, "package.json");
		if (!fs.existsSync(pkgPath)) {
			errors.push(new Error(`Permission-system package manifest is missing at ${pkgPath}.`));
			continue;
		}
		try {
			let pkg: { pi?: { extensions?: string[] } };
			const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("manifest root must be an object");
			}
			pkg = parsed as typeof pkg;
			const extensions = pkg.pi?.extensions;
			const entry = Array.isArray(extensions) ? extensions[0] : undefined;
			if (typeof entry !== "string" || !entry.trim()) {
				throw new Error(
					`Permission-system package manifest at ${pkgPath} must declare pi.extensions[0] as a non-empty string.`,
				);
			}
			const resolved = path.resolve(extDir, entry);
			if (fs.existsSync(resolved)) return resolved;
			throw new Error(
				`Permission-system extension entry ${JSON.stringify(entry)} in ${pkgPath} does not exist at ${resolved}.`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(message.startsWith("Permission-system") ? new Error(message) : new Error(`Cannot read permission-system package manifest at ${pkgPath}: ${message}`));
		}
	}
	if (errors.length > 0) throw errors[0]!;
	return undefined;
}

/**
 * Extract the names of builtin tools the host provides. Use this to pass
 * `hostAvailableBuiltins` to `resolvePiLaunchToolPlan` so child tool plans
 * intersect known core slots with what the host actually supports. Wrapped
 * core slots count regardless of source; host-specific builtins count too.
 *
 * Returns `undefined` when builtin tool discovery fails or yields nothing,
 * so callers skip the intersection (fail-safe to allowing all declared tools).
 * This handles test mocks without proper tool registration and hosts whose
 * getAllTools() throws before extensions load.
 */
export function getHostBuiltinToolNames(pi: Pick<ExtensionAPI, "getAllTools">): string[] | undefined {
	try {
		const builtins = pi
			.getAllTools()
			.filter((tool) => {
				const source = (tool.sourceInfo as { source?: string } | undefined)?.source;
				return source === "builtin" || PI_BUILTIN_TOOL_NAMES.has(tool.name);
			})
			.map((tool) => tool.name);
		return builtins.length > 0 ? builtins : undefined;
	} catch {
		return undefined;
	}
}

export function resolvePiLaunchToolPlan(
	input: ResolvePiLaunchToolPlanInput,
): PiLaunchToolPlan {
	const capabilityCeiling = intersectSubagentCapabilityCeilings(
		input.capabilityCeiling,
		input.inheritedCapabilityCeiling,
	);
	const requiredExtensions = snapshotRequiredChildExtensions(input.requiredExtensions ?? []);
	if (requiredExtensions.length > 0 && capabilityCeiling?.denyExtensions) {
		throw new Error(`Capability ceiling from ${capabilityCeiling.sources.join(", ") || "unknown source"} denies extensions but this host requires: ${requiredExtensions.map(({ id }) => id).join(", ")}.`);
	}
	const allowedToolSet =
		capabilityCeiling?.allowedTools === undefined
			? undefined
			: new Set(capabilityCeiling.allowedTools);
	const allowedToolLowered = allowedToolSet ? new Set([...allowedToolSet].map((tool) => tool.toLowerCase())) : undefined;
	const hostAvailableSet =
		input.hostAvailableBuiltins === undefined
			? undefined
			: new Set(input.hostAvailableBuiltins);
	const hostAvailableLowered = hostAvailableSet ? new Set([...hostAvailableSet].map((tool) => tool.toLowerCase())) : undefined;
	const isPathLikeEntry = (tool: string): boolean => tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js");
	const knownToolIdentities: HostToolIdentity[] = [
		...[...PI_BUILTIN_TOOL_NAMES, ...NATIVE_CHILD_TOOL_NAMES].map((name) => ({ name })),
		...(input.hostAvailableBuiltins ?? []).map((name) => ({ name })),
		...(input.hostAvailableTools ?? []),
		...(capabilityCeiling?.allowedTools ?? []).map((name) => ({ name })),
	];
	const canonicalizeEntry = (tool: string): string =>
		isPathLikeEntry(tool) ? tool : canonicalizeChildToolEntry(tool, knownToolIdentities);
	const rawRequestedBuiltinTools =
		input.tools?.filter((tool) => !isPathLikeEntry(tool)) ?? [];
	const requestedBuiltinTools = rawRequestedBuiltinTools.map(canonicalizeEntry);
	const toolLabelAliases = rawRequestedBuiltinTools
		.map((from, index) => ({ from, to: requestedBuiltinTools[index] as string }))
		.filter((pair) => pair.from !== pair.to);
	if (input.requireReadTool && hostAvailableSet && !hostAvailableSet.has("read")) {
		const agentLabel = input.agentName ? ` for agent '${input.agentName}'` : "";
		throw new Error(
			`Host runtime does not provide required tool 'read'${agentLabel} for lazy skill loading.`,
		);
	}
	if (input.requireReadTool && allowedToolSet && !allowedToolSet.has("read")) {
		throw new Error(
			`Capability ceiling from ${capabilityCeiling?.sources.join(", ") || "unknown source"} excludes required tool 'read' for lazy skill loading.`,
		);
	}
	const ceilingFilteredBuiltinTools =
		input.tools === undefined
			? allowedToolSet
				? [...allowedToolSet]
				: []
			: (input.requireReadTool &&
				requestedBuiltinTools.length > 0 &&
				!requestedBuiltinTools.some((tool) => childToolNamesEqual(tool, "read")) &&
				!allowedToolSet
					? ["read", ...requestedBuiltinTools]
					: requestedBuiltinTools
				).filter((tool) => !allowedToolLowered || allowedToolLowered.has(tool.toLowerCase()));
	const declaredBuiltinTools = hostAvailableSet
		? ceilingFilteredBuiltinTools.filter((tool) => !PI_BUILTIN_TOOL_NAMES.has(tool.toLowerCase()) || hostAvailableSet.has(tool) || hostAvailableLowered?.has(tool.toLowerCase()))
		: ceilingFilteredBuiltinTools;
	const unavailableHostBuiltins = hostAvailableSet
		? ceilingFilteredBuiltinTools.filter((tool) => PI_BUILTIN_TOOL_NAMES.has(tool.toLowerCase()) && !hostAvailableSet.has(tool) && !hostAvailableLowered?.has(tool.toLowerCase()))
		: [];
	const excludeTools = [...new Set((input.excludeTools ?? []).map((tool) => canonicalizeEntry(tool.trim())).filter(Boolean))];
	const excludedToolLowered = new Set(excludeTools.map((tool) => tool.toLowerCase()));
	const isExcluded = (tool: string): boolean => excludedToolLowered.has(tool.toLowerCase());
	const effectiveDeclaredBuiltinTools = declaredBuiltinTools.filter((tool) => !isExcluded(tool));
	const declaresTool = (tools: readonly string[], name: string): boolean => tools.some((tool) => childToolNamesEqual(tool, name));
	const fanoutAuthorized = declaresTool(effectiveDeclaredBuiltinTools, "subagent") || (
		input.allowNestedSubagents === true &&
		!isExcluded("subagent") &&
		(!allowedToolLowered || allowedToolLowered.has("subagent"))
	);
	if (declaresTool(effectiveDeclaredBuiltinTools, "subagent_supervisor") && !fanoutAuthorized) {
		throw new Error("Tool 'subagent_supervisor' requires fanout authorization: include 'subagent' in the effective tools allowlist or enable allowNestedSubagents.");
	}
	const toolExtensionPaths: string[] = capabilityCeiling?.denyExtensions
		? []
		: (input.tools ?? []).filter(
				(tool) =>
					!requestedBuiltinTools.includes(tool) &&
					(tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")),
			);
	const mcpResolution = capabilityCeiling?.denyExtensions
		? { selections: [], unresolvedSelectors: [] }
		: resolveMcpDirectToolResolution(input.mcpDirectTools, input.cwd, input.runtimeSnapshotHost);
	if (mcpResolution.runtimeServerNames?.length) {
		throw new Error(formatRuntimeSnapshotMcpServersError(input.agentName, mcpResolution.runtimeServerNames));
	}
	if (mcpResolution.unresolvedSelectors.length > 0) {
		throw new Error(formatUnresolvedMcpDirectToolSelectors(mcpResolution.unresolvedSelectors));
	}
	const resolvedMcpSelections = mcpResolution.selections;
	const resolvedMcpNames = new Set(resolvedMcpSelections.map((selection) => selection.name));
	const legacyMcpNameCounts = countLegacyUnderscoreMcpToolNames(resolvedMcpSelections);
	const effectiveMcpSelections = resolvedMcpSelections.filter(
		(selection) =>
			!allowedToolSet ||
			allowedToolSet.has(selection.name) ||
			allowedToolLowered?.has(selection.name.toLowerCase()) ||
			isLegacyUnderscoreMcpToolAllowed(selection, allowedToolSet, resolvedMcpNames, legacyMcpNameCounts),
	).filter((selection) => !isExcluded(selection.name));
	const effectiveMcpTools = effectiveMcpSelections.map(
		(selection) => selection.name,
	);
	const explicitToolAllowlist =
		input.tools !== undefined ||
		(input.mcpDirectTools?.length ?? 0) > 0 ||
		allowedToolSet !== undefined;
	const internalTools = (input.structuredOutput ? ["structured_output"] : []).filter((tool) => !isExcluded(tool));
	const effectiveToolAllowlist = withChildToolCaseVariants([
		...effectiveDeclaredBuiltinTools,
		...effectiveMcpTools,
		...internalTools,
	]);
	// Upward contact stays in the --tools allowlist but is not a strict
	// requirement: children register contact_supervisor at runtime through
	// the native supervisor channel (or pi-intercom). The pre-0.50 bridge always
	// appended intercom alongside contact_supervisor, so that exact pairing is
	// legacy plumbing, not a user demand for an external intercom provider;
	// a lone intercom entry stays strictly required (#1207).
	const legacySupervisorPairing = declaresTool(effectiveDeclaredBuiltinTools, "contact_supervisor");
	const requiredChildTools = explicitToolAllowlist
		? [
				...new Set([
					...(input.tools !== undefined ? effectiveDeclaredBuiltinTools : []),
					...(input.mcpDirectTools?.length ? effectiveMcpTools : []),
					...internalTools,
				].filter((tool) => tool !== "contact_supervisor" && (!legacySupervisorPairing || tool !== "intercom"))),
			]
		: [];
	const permSystemExt = capabilityCeiling?.denyExtensions
		? undefined
		: hasPermissionRules(input.permissionRules)
			? resolvePermissionSystemExtension()
			: undefined;
	if (input.fast && capabilityCeiling?.denyExtensions) throw new Error("fast mode requires a child runtime extension, but this launch denies extensions.");
	const fastModeExtensions = resolveFastModeExtension({ fast: input.fast, model: input.model, modelCandidates: input.modelCandidates, agentName: input.agentName });
	const runtimeExtensions = [
		PROMPT_RUNTIME_EXTENSION_PATH,
		...fastModeExtensions,
		...(fanoutAuthorized ? [FANOUT_CHILD_EXTENSION_PATH] : []),
		...(permSystemExt ? [permSystemExt] : []),
	];
	const disableAmbientExtensions =
		capabilityCeiling?.denyExtensions === true ||
		input.extensions !== undefined;
	const warnings: string[] = [];
	for (const alias of toolLabelAliases) {
		const subject = input.agentName ? `Agent '${input.agentName}'` : "Subagent";
		warnings.push(`${subject}: tools entry '${alias.from}' resolved to internal tool '${alias.to}'.`);
	}
	// An explicit empty list disables ambient extensions, including model providers.
	if (capabilityCeiling?.denyExtensions !== true && Array.isArray(input.extensions) && input.extensions.length === 0) {
		const agentLabel = input.agentName ? ` for agent '${input.agentName}'` : "";
		warnings.push(
			`extensions: [] override${agentLabel} disables ALL ambient extensions for this child (not just "adds nothing"), `
				+ "including any model-provider extension needed to resolve a provider-qualified model. "
				+ "List the extensions this child actually needs instead of an empty array.",
		);
	}
	const configuredExtensions = capabilityCeiling?.denyExtensions
		? []
		: [
				...toolExtensionPaths,
				...(input.extensions ?? []),
				...(input.subagentOnlyExtensions ?? []),
			];
	const ordinaryExtensionArgs = disableAmbientExtensions
		? [...new Set([...runtimeExtensions, ...configuredExtensions])]
		: [
				...new Set([
					...runtimeExtensions,
					...toolExtensionPaths,
					...(input.subagentOnlyExtensions ?? []),
				]),
			];
	// Host-required paths have final precedence and cannot be removed by agent defaults or overrides.
	const extensionArgs = [...new Set([...ordinaryExtensionArgs, ...requiredExtensions.map(({ path }) => path)])];
	const requestedToolNames =
		input.tools !== undefined
			? [
					...new Set([
						...requestedBuiltinTools,
						...resolvedMcpSelections.map((selection) => selection.name),
					]),
				]
			: undefined;
	const missingPermittedRepositoryTools = input.tools !== undefined
		? missingPermittedRepositoryInspectionTools(unavailableHostBuiltins, excludeTools)
		: [];
	if (missingPermittedRepositoryTools.length > 0 && isReviewOrScoutLaneAgent(input.agentName)) {
		throw new Error(formatReviewLaneToolContractFailure({
			agentName: input.agentName,
			missingTools: missingPermittedRepositoryTools,
			requestedTools: requestedToolNames,
			effectiveTools: effectiveToolAllowlist,
			ceilingSources: capabilityCeiling?.sources,
			excludeTools,
		}));
	}
	// Host pruning also happens without a ceiling (and therefore without an
	// audit). Use the existing non-fatal launch warnings rather than inventing
	// a ceiling or treating the requested allowlist as a minimum requirement.
	if (unavailableHostBuiltins.length > 0) {
		const subject = input.agentName ? `Agent '${input.agentName}'` : "Subagent";
		warnings.push(
			`${subject}: host runtime tool availability omitted [${unavailableHostBuiltins.join(", ")}]. `
				+ `Requested tool names: ${requestedToolNames ? `[${requestedToolNames.join(", ")}]` : "not explicitly specified"}; effective tool allowlist: [${effectiveToolAllowlist.join(", ")}]. `
				+ (capabilityCeiling ? `Active capability ceiling sources: [${capabilityCeiling.sources.join(", ") || "unknown source"}]. ` : "")
				+ (excludeTools.length > 0 ? `Explicit excludeTools: [${excludeTools.join(", ")}]. ` : "")
				+ "This is a non-fatal tool-plan diagnostic, not verification of the child's runtime tool menu.",
		);
	}
	const capabilityAudit = capabilityCeiling
		? ({
				ceiling: capabilityCeiling,
				...(requestedToolNames ? { requestedTools: requestedToolNames } : {}),
				effectiveTools: effectiveToolAllowlist,
				...(excludeTools.length > 0 ? { excludeTools } : {}),
				removedTools:
					requestedToolNames?.filter(
						(tool) => !effectiveToolAllowlist.includes(tool),
					) ?? [],
				internalTools,
				extensionsDenied: capabilityCeiling.denyExtensions,
				removedExtensionCount: capabilityCeiling.denyExtensions
					? (input.extensions?.length ?? 0) +
						(input.subagentOnlyExtensions?.length ?? 0) +
						(input.tools ?? []).filter(
							(tool) =>
								tool.includes("/") ||
								tool.endsWith(".ts") ||
								tool.endsWith(".js"),
						).length
					: 0,
				requestedMcpToolCount: input.mcpDirectTools?.length ?? 0,
				effectiveMcpTools,
				agentAllowed:
					input.agentName === undefined
						? true
						: isAgentAllowedByCapabilityCeiling(
								input.agentName,
								capabilityCeiling,
							),
				...(capabilityCeilingAgentRestrictionSources(capabilityCeiling)
					? {
							agentRestrictionSources:
								capabilityCeilingAgentRestrictionSources(capabilityCeiling),
						}
					: {}),
				...(unavailableHostBuiltins.length > 0 ? { unavailableHostBuiltins } : {}),
			} satisfies SubagentCapabilityAudit)
		: undefined;
	return {
		...(capabilityCeiling ? { capabilityCeiling } : {}),
		requestedBuiltinTools,
		declaredBuiltinTools,
		excludeTools,
		toolExtensionPaths,
		resolvedMcpSelections,
		effectiveMcpSelections,
		effectiveMcpTools,
		explicitToolAllowlist,
		internalTools,
		effectiveToolAllowlist,
		requiredChildTools,
		fanoutAuthorized,
		runtimeExtensions,
		configuredExtensions,
		requiredExtensions,
		extensionArgs,
		disableAmbientExtensions,
		warnings,
		unavailableHostBuiltins,
		...(capabilityAudit ? { capabilityAudit } : {}),
	};
}

// Capability ceilings persisted before #1685 may still name hyphenated MCP server prefixes with underscores.
function countLegacyUnderscoreMcpToolNames(selections: readonly ResolvedMcpDirectToolSelection[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const selection of selections) {
		const legacyName = legacyUnderscoreMcpToolName(selection);
		if (legacyName !== selection.name) counts.set(legacyName, (counts.get(legacyName) ?? 0) + 1);
	}
	return counts;
}

function isLegacyUnderscoreMcpToolAllowed(
	selection: ResolvedMcpDirectToolSelection,
	allowedToolSet: ReadonlySet<string>,
	resolvedMcpNames: ReadonlySet<string>,
	legacyMcpNameCounts: ReadonlyMap<string, number>,
): boolean {
	const legacyName = legacyUnderscoreMcpToolName(selection);
	return legacyMcpNameCounts.get(legacyName) === 1 && !resolvedMcpNames.has(legacyName) && allowedToolSet.has(legacyName);
}

function legacyUnderscoreMcpToolName(selection: ResolvedMcpDirectToolSelection): string {
	const slash = selection.selector.indexOf("/");
	if (slash < 1) return selection.name;
	const toolName = selection.selector.slice(slash + 1);
	const suffix = `_${toolName}`;
	if (!selection.name.endsWith(suffix)) return selection.name;
	const prefix = selection.name.slice(0, -suffix.length);
	return `${prefix.replace(/-/g, "_")}${suffix}`;
}
