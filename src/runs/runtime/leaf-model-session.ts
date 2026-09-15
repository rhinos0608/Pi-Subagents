/**
 * Verified leaf-model adapter. Exact model selection only: strict
 * `provider/id` lookup, no normalization, no thinking suffix, no fallback
 * helper calls, no parent history/tools/delegation inheritance.
 *
 * The real-host binding (`probeRealLeafHost()`) resolves the installed
 * `@earendil-works/pi-coding-agent` SDK, derives its version from the
 * installed package manifest, and returns a working `LeafHost` only when
 * that version is allowlisted. Shim, absent, or unverified installs stay
 * fail-closed (null). Unit tests inject a fake `LeafHost` to prove exact
 * selection, payload-cap assertion, isolation spec, and usage proof without
 * network or credentials.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	RUNTIME_RPC_AUDITED_APIS,
	RUNTIME_RPC_BOUNDS,
	RUNTIME_RPC_REJECTED_APIS,
	VERIFIED_RUNTIME_HOST_VERSIONS,
} from "../../api/runtime-rpc.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import { createNativeLeafHost, type NativeSdkModules } from "./leaf-host-native.ts";
import { resolveFromParent } from "./resolve-from-parent.ts";

export const LEAF_SYSTEM_PROMPT = "Execute the user task. Return plain text only. Use no tools.";

/**
 * Known SDK default builtins (the SDK's `defaultActiveToolNames` in
 * `core/sdk.js`): explicit `excludeTools` belt and braces behind
 * `noTools: "all"`. That list is exactly these four; extension/custom
 * tools are off separately via `noExtensions` + `noTools: "all"`.
 */
export const LEAF_EXCLUDE_TOOLS: readonly string[] = ["read", "bash", "edit", "write"];

export interface AuditedLeafModel {
	provider: string;
	id: string;
	api: string;
	maxTokens: number;
	contextWindow?: number;
}

export interface LeafSessionSpec {
	storage: { kind: "memory" };
	cwd: string;
	model: AuditedLeafModel;
	systemPrompt: string;
	tools: [];
	excludeTools: string[];
	ambientExtensions: false;
	extensionPaths: [];
	noSkills: true;
	noPromptTemplates: true;
	noThemes: true;
	noContextFiles: true;
	initialHistory: [];
	autoRetry: false;
	autoCompaction: false;
	maxTurns: 1;
}

export interface LeafPromptResult {
	text: string;
	/** Normalized integer output-token usage. Absent/unverifiable usage fails the run. */
	outputTokens?: number;
	toolCalls: number;
	providerInvocations: number;
}

export interface LeafSessionHandle {
	prompt(text: string): Promise<LeafPromptResult>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	dispose(): Promise<void>;
}

/** Injectable host seam. Production binds the real SDK; tests inject fakes. */
export interface LeafHost {
	hostVersion: string;
	listModels(): ModelInfo[];
	createLeafSession(spec: LeafSessionSpec): Promise<LeafSessionHandle>;
}

export type LeafFailureCode =
	| "model_unavailable"
	| "unsupported_capability"
	| "invalid_params"
	| "output_token_limit_exceeded"
	| "output_contract_breach"
	| "provider_error";

export class LeafFailure extends Error {
	readonly code: LeafFailureCode;
	constructor(code: LeafFailureCode, message: string) {
		super(message);
		this.name = "LeafFailure";
		this.code = code;
	}
}

/** Host gate: shim and unlisted versions never open. */
export function isVerifiedHostVersion(hostVersion: string): boolean {
	if (typeof hostVersion !== "string" || hostVersion.length === 0) return false;
	if (hostVersion.includes("test-shim")) return false;
	return (VERIFIED_RUNTIME_HOST_VERSIONS as readonly string[]).includes(hostVersion);
}

function auditedApi(api: string | undefined): boolean {
	if (!api) return false;
	if ((RUNTIME_RPC_REJECTED_APIS as readonly string[]).includes(api)) return false;
	return (RUNTIME_RPC_AUDITED_APIS as readonly string[]).includes(api);
}

/**
 * Exact model resolution. Single strict `fullId` match; bare IDs, aliases,
 * preferred-provider disambiguation, and fallback lists are rejected.
 */
export function resolveExactModel(modelId: string, available: ModelInfo[]): AuditedLeafModel {
	const matches = available.filter((entry) => entry.fullId === modelId);
	if (matches.length !== 1 || !matches[0]) {
		throw new LeafFailure("model_unavailable", "Exact model unavailable.");
	}
	const model = matches[0];
	if (!auditedApi(model.api)) {
		throw new LeafFailure("unsupported_capability", "Model API unaudited for leaf execution.");
	}
	// Reject routing/gateway metadata and noncanonical endpoints smuggled on
	// the model record; the clone below carries only audited fields.
	const record = model as unknown as Record<string, unknown>;
	for (const field of ["streamOverride", "customStream", "gateway", "route", "fallbackModels", "endpoint", "baseUrl"]) {
		if (record[field] !== undefined) {
			throw new LeafFailure("unsupported_capability", "Model carries unaudited routing metadata.");
		}
	}
	if (typeof model.maxTokens !== "number" || !Number.isFinite(model.maxTokens) || model.maxTokens <= 0) {
		throw new LeafFailure("unsupported_capability", "Model maximum output tokens unknown.");
	}
	return {
		provider: model.provider,
		id: model.id,
		api: model.api as string,
		maxTokens: Math.floor(model.maxTokens),
		...(typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0
			? { contextWindow: Math.floor(model.contextWindow) }
			: {}),
	};
}

/**
 * Effective cap is min(server ceiling, model max). Requests above the
 * effective cap are rejected, never clamped. Requests below the Responses
 * minimum fail, never widened.
 */
export function resolveEffectiveCap(model: AuditedLeafModel, requested: number): number {
	const effective = Math.min(RUNTIME_RPC_BOUNDS.maxNegotiatedOutputTokens, model.maxTokens);
	if (requested > effective) {
		throw new LeafFailure("invalid_params", "Requested cap exceeds model maximum.");
	}
	if (model.api === "openai-responses" && requested < RUNTIME_RPC_BOUNDS.minResponsesOutputTokens) {
		throw new LeafFailure("invalid_params", "Requested cap below Responses minimum.");
	}
	return requested;
}

/**
 * Assert an observable outbound provider payload carries the requested cap
 * exactly. Throws on absence, widening, or ambiguous duplication.
 *
 * Residual: the native adapter cannot observe the SDK's internal provider
 * payload, so this validator is NOT wired into the live path — there the
 * pre-call spec-cap check runs before any provider call and over-cap
 * usage fails post-hoc. This covers payloads the caller can observe.
 */
export function assertOutboundTokenCap(api: string, payload: unknown, expected: number): void {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new LeafFailure("output_contract_breach", "Provider payload missing token cap.");
	}
	const record = payload as Record<string, unknown>;
	if (api === "openai-responses") {
		if (record.max_output_tokens !== expected) {
			throw new LeafFailure("output_contract_breach", "Responses payload cap absent or altered.");
		}
		return;
	}
	if (api === "anthropic-messages") {
		if (record.max_tokens !== expected) {
			throw new LeafFailure("output_contract_breach", "Anthropic payload cap absent or altered.");
		}
		return;
	}
	if (api === "openai-completions") {
		const a = record.max_tokens;
		const b = record.max_completion_tokens;
		const aSet = a !== undefined;
		const bSet = b !== undefined;
		if (aSet && bSet) throw new LeafFailure("output_contract_breach", "Completions payload cap ambiguous.");
		if ((aSet && a !== expected) || (bSet && b !== expected) || (!aSet && !bSet)) {
			throw new LeafFailure("output_contract_breach", "Completions payload cap absent or altered.");
		}
		return;
	}
	throw new LeafFailure("unsupported_capability", "Unaudited provider API.");
}

/** Minimal audited model clone: requested cap replaces any wider limit. */
export function cloneModelWithCap(model: AuditedLeafModel, cap: number): AuditedLeafModel {
	return { provider: model.provider, id: model.id, api: model.api, maxTokens: cap };
}

/** Fresh zero-tool in-memory leaf spec. One model turn, no inheritance. */
export function buildLeafSessionSpec(cwd: string, model: AuditedLeafModel, cap: number): LeafSessionSpec {
	return {
		storage: { kind: "memory" },
		cwd,
		model: cloneModelWithCap(model, cap),
		systemPrompt: LEAF_SYSTEM_PROMPT,
		tools: [],
		excludeTools: [...LEAF_EXCLUDE_TOOLS],
		ambientExtensions: false,
		extensionPaths: [],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		initialHistory: [],
		autoRetry: false,
		autoCompaction: false,
		maxTurns: 1,
	};
}

export interface LeafRunInput {
	modelId: string;
	prompt: string;
	maxOutputTokens: number;
	cwd: string;
}

export interface LeafRunSuccess {
	output: string;
	outputTokens: number;
}

/**
 * One-turn leaf execution against an injected host. Verifies usage proof:
 * finite positive integer output usage required; over-cap usage fails; tool
 * calls, extra provider invocations, or empty/whitespace-only text fail;
 * missing usage fails.
 */
export async function executeLeafRun(host: LeafHost, input: LeafRunInput): Promise<LeafRunSuccess> {
	const model = resolveExactModel(input.modelId, host.listModels());
	const cap = resolveEffectiveCap(model, input.maxOutputTokens);
	const spec = buildLeafSessionSpec(input.cwd, model, cap);
	// Pre-call spec-cap check: the audited session spec must carry the
	// requested cap exactly. This rejects widening/clamping before any
	// provider call but is NOT a pre-transmission payload proof — the SDK
	// hides the transmitted payload (see assertOutboundTokenCap residual).
	if (spec.model.maxTokens !== cap) throw new LeafFailure("output_contract_breach", "Leaf spec cap absent or altered.");
	const session = await host.createLeafSession(spec).catch((error) => {
		if (error instanceof LeafFailure) throw error;
		throw new LeafFailure("provider_error", "Leaf session creation failed.");
	});
	let result: LeafPromptResult;
	try {
		result = await session.prompt(input.prompt);
	} catch (error) {
		if (error instanceof LeafFailure) throw error;
		throw new LeafFailure("provider_error", "Leaf prompt failed.");
	} finally {
		await session.dispose().catch(() => {});
	}
	if (result.toolCalls !== 0) throw new LeafFailure("output_contract_breach", "Leaf run used tools.");
	if (result.providerInvocations !== 1) throw new LeafFailure("output_contract_breach", "Leaf run left single-turn contract.");
	// pi-ai initializes zero usage when the provider omits it; zero is not
	// proof. Require finite positive integer reported usage (NaN/Infinity
	// explicitly rejected).
	if (
		typeof result.outputTokens !== "number"
		|| !Number.isFinite(result.outputTokens)
		|| !Number.isInteger(result.outputTokens)
		|| result.outputTokens <= 0
	) {
		throw new LeafFailure("output_contract_breach", "Output token usage unverifiable.");
	}
	if (result.outputTokens > cap) throw new LeafFailure("output_token_limit_exceeded", "Output exceeded requested cap.");
	// A leaf run producing no text is not a success.
	if (typeof result.text !== "string" || result.text.trim().length === 0) {
		throw new LeafFailure("output_contract_breach", "Leaf run produced no text.");
	}
	return { output: result.text, outputTokens: result.outputTokens };
}

/** Package specifier of the real leaf host SDK. */
export const NATIVE_HOST_SPECIFIER = "@earendil-works/pi-coding-agent";

/** pi-ai registry entry points, preferred first. Resolved against the SDK install. */
const NATIVE_HOST_PI_AI_SPECIFIERS = ["@earendil-works/pi-ai/compat", "@earendil-works/pi-ai"];

export interface RealHostProbeOptions {
	/** File path used as the module-resolution base. Defaults to this module
	 * (the installed dependency tree). Tests point it at a real SDK install. */
	resolutionBase?: string;
	/** Module loader seam. Defaults to dynamic import. */
	load?: (url: string) => Promise<unknown>;
	/**
	 * Specifier resolver seam. Defaults to manifest-aware resolution.
	 * `require.resolve` rejects import-only exports maps on this Node
	 * (`ERR_PACKAGE_PATH_NOT_EXPORTED`), so resolution goes through the
	 * manifest exports map with dist fallbacks.
	 */
	resolve?: (specifier: string, base: string) => string | null;
}

/**
 * Resolve a package specifier to an entry file using manifests only.
 * Prefers `createRequire.resolve` (handles nested/shimmed layouts), then
 * falls back to a manifest walk: the exports map here is import-only
 * (`ERR_PACKAGE_PATH_NOT_EXPORTED` under `require.resolve` on this Node),
 * so ESM dynamic import needs the mapped dist file directly.
 */
function resolveFromBase(specifier: string, base: string): string | null {
	try {
		return createRequire(base).resolve(specifier);
	} catch {
		return resolveEntryFromManifest(specifier, base);
	}
}

function manifestEntry(pkgDir: string): string | null {
	try {
		const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
			main?: unknown;
			exports?: unknown;
		};
		const dot = (manifest.exports as Record<string, unknown> | undefined)?.["."];
		const dotImport = typeof dot === "string" ? dot : (dot as { import?: unknown } | undefined)?.import;
		for (const candidate of [dotImport, manifest.main, "./dist/index.js"]) {
			if (typeof candidate !== "string" || candidate.length === 0) continue;
			const entry = join(pkgDir, candidate);
			if (existsSync(entry)) return entry;
		}
	} catch {
		// Unreadable manifests never resolve; caller tries the next scope.
	}
	return null;
}

/**
 * Manifest-only specifier resolution. Splits `pkg/subpath`, walks up from
 * the base looking for the package dir (including nested `node_modules`
 * scopes), then maps the subpath through the manifest exports map with a
 * `dist/<subpath>.js` fallback. Handles import-only exports maps and bare
 * package names (mapped through `.` -> `main` -> `dist/index.js`).
 */
function resolveEntryFromManifest(specifier: string, base: string): string | null {
	const slash = specifier.indexOf("/");
	const pkgName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.slice(0, slash);
	const subpath = specifier.slice(pkgName.length);
	let dir = dirname(base);
	for (let depth = 0; depth < 12; depth += 1) {
		const scoped = join(dir, "node_modules", pkgName);
		for (const pkgDir of [dir, scoped]) {
			let manifest: { name?: unknown; exports?: Record<string, unknown> };
			try {
				if (!existsSync(join(pkgDir, "package.json"))) continue;
				manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
			} catch {
				continue;
			}
			if (manifest.name !== pkgName) continue;
			if (!subpath) return manifestEntry(pkgDir);
			const target = manifest.exports?.[`.${subpath}`];
			const targetImport = typeof target === "string" ? target : (target as { import?: unknown } | undefined)?.import;
			if (typeof targetImport === "string") {
				const entry = join(pkgDir, targetImport);
				if (existsSync(entry)) return entry;
			}
			const distFallback = join(pkgDir, "dist", `${subpath.replace(/^\//, "")}.js`);
			if (existsSync(distFallback)) return distFallback;
			return null;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	// SDK exports surface as classes/namespaces (functions), not plain
	// objects — accept both so structural checks see static members.
	if (typeof value !== "object" && typeof value !== "function") return null;
	if (value === null) return null;
	return value as Record<string, unknown>;
}

/**
 * Strict semver for host version stamping: digits.digits.digits with an
 * optional prerelease suffix. No leading/trailing whitespace, no control
 * characters, no `v` prefix, no missing components. Malformed versions stay
 * fail-closed (probe returns null, never stamps hostVersion).
 */
export const STRICT_HOST_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Derive the installed SDK version from its package manifest. Walks up from
 * the resolved entry point to the nearest package.json carrying the SDK
 * package name. Never reads version overrides from the environment.
 * The manifest version must match STRICT_HOST_SEMVER before stamping;
 * malformed values return null (fail closed).
 */
function readInstalledHostVersion(entryPath: string, packageName: string): string | null {
	let dir = dirname(entryPath);
	for (let depth = 0; depth < 8; depth += 1) {
		const candidate = join(dir, "package.json");
		try {
			if (existsSync(candidate)) {
				const manifest = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown; version?: unknown };
				if (
					manifest.name === packageName
					&& typeof manifest.version === "string"
					&& STRICT_HOST_SEMVER.test(manifest.version)
				) {
					return manifest.version;
				}
		}
	} catch {
		// Unreadable manifests never verify; keep walking up.
	}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Real-host probe. Returns a working `LeafHost` when the installed SDK
 * qualifies: no test shim, `SessionManager.inMemory` plus
 * `createAgentSession` present, pi-ai registry resolvable, and the
 * manifest-derived host version allowlisted. Every other install
 * (shim, absent, structurally incomplete, unverified version) returns null
 * and readiness stays disabled there.
 */
export async function probeRealLeafHost(options: RealHostProbeOptions = {}): Promise<LeafHost | null> {
	const base = options.resolutionBase ?? fileURLToPath(import.meta.url);
	const load = options.load ?? ((url: string) => import(url));
	const sdkPath = resolveFromBase(NATIVE_HOST_SPECIFIER, base);
	if (!sdkPath) return null;
	const sdk = asRecord(await load(pathToFileURL(sdkPath).href).catch(() => null));
	// Presence-rejection (not truthy): any __piSubagentsTestShim property in
	// any form marks a shim/masquerade, matching the proof helper's checks.
	if (!sdk || "__piSubagentsTestShim" in sdk) return null;
	const sessionManager = asRecord(sdk.SessionManager);
	if (typeof sessionManager?.inMemory !== "function" || typeof sdk.createAgentSession !== "function") {
		return null;
	}
	if (typeof sdk.DefaultResourceLoader !== "function") return null;
	const hostVersion = readInstalledHostVersion(sdkPath, NATIVE_HOST_SPECIFIER);
	if (!hostVersion || !isVerifiedHostVersion(hostVersion)) return null;
	// Resolve pi-ai against the SDK install itself: the SDK may carry a
	// nested pi-ai whose version differs from any top-level install, and
	// the catalog the host actually reads must come from the SDK's tree.
	// `import.meta.resolve` from the SDK entry handles nested scopes;
	// manifest resolution is the fallback.
	const resolve = options.resolve ?? resolveFromBase;
	const sdkUrl = pathToFileURL(sdkPath).href;
	// Direct path candidates first: nested pi-ai under the SDK install wins
	// over any top-level copy, and `import.meta.resolve` from a foreign tree
	// is unreliable across installs. Manifest resolution stays as fallback.
	const sdkDir = dirname(sdkPath);
	const piAiCandidates: Array<{ specifier: string; path: string }> = [];
	for (const specifier of NATIVE_HOST_PI_AI_SPECIFIERS) {
		const leaf = specifier.endsWith("/compat") ? "compat.js" : "index.js";
		piAiCandidates.push({
			specifier,
			path: join(sdkDir, "..", "node_modules", "@earendil-works", "pi-ai", "dist", leaf),
		});
		let dir = sdkDir;
		for (let depth = 0; depth < 8; depth += 1) {
			piAiCandidates.push({
				specifier,
				path: join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", leaf),
			});
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	let piAiPath: string | null = null;
	for (const candidate of piAiCandidates) {
		try {
			if (existsSync(candidate.path)) {
				piAiPath = candidate.path;
				break;
			}
		} catch {
			// Unreadable candidate; keep scanning.
		}
	}
	if (!piAiPath) {
		try {
			const url = resolveFromParent(NATIVE_HOST_PI_AI_SPECIFIERS[0]!, sdkUrl);
			if (url.startsWith("file://")) piAiPath = fileURLToPath(url);
		} catch {
			// Unresolvable from the SDK scope; try manifest resolution.
		}
	}
	for (const specifier of NATIVE_HOST_PI_AI_SPECIFIERS) {
		if (piAiPath) break;
		piAiPath = resolve(specifier, sdkPath);
	}
	if (!piAiPath) return null;
	const piAi = asRecord(await load(pathToFileURL(piAiPath).href).catch(() => null));
	const getBuiltinProviders = piAi?.getBuiltinProviders ?? piAi?.getProviders;
	const getBuiltinModels = piAi?.getBuiltinModels ?? piAi?.getModels;
	const getBuiltinModel = piAi?.getBuiltinModel ?? piAi?.getModel;
	if (typeof getBuiltinProviders !== "function" || typeof getBuiltinModels !== "function" || typeof getBuiltinModel !== "function") {
		return null;
	}
	const settingsManager = asRecord(sdk.SettingsManager);
	const getAgentDir = typeof sdk.getAgentDir === "function" ? (sdk.getAgentDir as () => string) : undefined;
	return createNativeLeafHost(
		{
			SessionManager: sessionManager as unknown as NativeSdkModules["SessionManager"],
			createAgentSession: sdk.createAgentSession as unknown as NativeSdkModules["createAgentSession"],
			DefaultResourceLoader: sdk.DefaultResourceLoader as unknown as NativeSdkModules["DefaultResourceLoader"],
			...(
				settingsManager && typeof settingsManager.create === "function"
					? { SettingsManager: settingsManager as unknown as NativeSdkModules["SettingsManager"] }
					: {}
			),
			...(getAgentDir ? { getAgentDir } : {}),
			getBuiltinProviders: getBuiltinProviders as NativeSdkModules["getBuiltinProviders"],
			getBuiltinModels: getBuiltinModels as NativeSdkModules["getBuiltinModels"],
			getBuiltinModel: getBuiltinModel as NativeSdkModules["getBuiltinModel"],
		},
		hostVersion,
	);
}
