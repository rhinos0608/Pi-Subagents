/**
* TypeBox schemas for subagent tool parameters
*/

import { Type } from "typebox";

function keepTopLevelParameterDescriptions<T>(schema: T): T {
	return pruneNestedDescriptions(schema, []) as T;
}

function pruneNestedDescriptions(value: unknown, path: string[]): unknown {
	if (!value || typeof value !== "object") return value;

	const result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) continue;
		if (key === "description" && !isTopLevelParameterDescription(path)) continue;
		if ("value" in descriptor) {
			const nextPath = typeof key === "string" ? [...path, key] : path;
			descriptor.value = pruneNestedDescriptions(descriptor.value, nextPath);
		}
		Object.defineProperty(result, key, descriptor);
	}
	return result;
}

function isTopLevelParameterDescription(path: string[]): boolean {
	return path.length === 2 && path[0] === "properties";
}

const ReadsOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean" },
	],
	description: "Files to read before running (array of filenames), or false to disable",
});

const JsonSchemaObject = Type.Unsafe({
	type: "object",
	additionalProperties: true,
	description: "Strict structured output; object-root JSON Schema only.",
});

const OutputSchemaOverride = Type.Unsafe({
	anyOf: [JsonSchemaObject, { type: "boolean" }],
	description: "Structured output schema override; false disables an agent default.",
});

// Provider boolean branches intentionally overapproximate false-only runtime inputs.
// Restricted function-declaration converters only support string enum members.
const AcceptanceOverride = Type.Unsafe({
	anyOf: [
		{ type: "string", enum: ["auto", "attested", "checked"] },
		{
			type: "string",
			enum: ["reviewed"],
			deprecated: true,
			description: "Invalid as an explicit policy. Recognized only so preflight can explain that reviewed is an achieved status.",
		},
		{
			type: "string",
			pattern: "^\\s*\\{",
		},
		{ type: "boolean" },
		{ type: "object", additionalProperties: true },
	],
	description: "Evidence policy; omit for read-only/review. false disables; true invalid. Prefer object; see guide tool-reference for levels, evidence and review.required.",
});

const AgentContractOverride = Type.Object({
	version: Type.Integer({ minimum: 1, maximum: 1, description: "Enable compatibility behavior for this run/child." }),
}, { additionalProperties: false, description: "Compatibility behavior. Omit for the default behavior." });

const ChainGateOverride = Type.String({
	enum: ["execution", "acceptance"],
	description: "For chain steps with agentContract, choose whether the chain advances on execution success or acceptance success. Defaults to execution.",
});

const WorkflowLaneMetadata = Type.Object({
	version: Type.Integer({ minimum: 1, maximum: 1 }),
	key: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
	mode: Type.Optional(Type.String({ enum: ["mutation", "review", "scout", "gate"] })),
	sourceRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	claims: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 20 })),
	outputPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 10 })),
}, { additionalProperties: false, description: "Display/triage only; sourceRef is opaque, never resolved by status." });

const ToolBudgetBlock = Type.Unsafe({
	anyOf: [
		{ type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
		{ type: "string", enum: ["*"] },
	],
});

const ToolBudgetOverride = Type.Object({
	soft: Type.Optional(Type.Integer({ minimum: 1 })),
	hard: Type.Integer({ minimum: 1 }),
	block: Type.Optional(ToolBudgetBlock),
}, { additionalProperties: false, description: "soft <= hard; after hard block read/grep/find/ls or '*' for all." });

const WorkflowPreflightLane = Type.Object({
	key: Type.String({ minLength: 1, maxLength: 128 }),
	mode: Type.Optional(Type.String({ enum: ["mutation", "review", "scout", "gate"] })),
	decision: Type.Optional(Type.String({ maxLength: 256 })),
	claims: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 16 })),
	expectedOutput: Type.Optional(Type.String({ maxLength: 256 })),
	independence: Type.Optional(Type.String({ maxLength: 256 })),
}, { additionalProperties: false });

const WorkflowPreflightOverride = Type.Object({
	version: Type.Integer({ minimum: 1, maximum: 1 }),
	coverage: Type.Optional(Type.String({ enum: ["complete", "partial"] })),
	lanes: Type.Array(WorkflowPreflightLane, { maxItems: 64 }),
}, { additionalProperties: false, description: "workflowScript/workflowScriptPath only; display-only hints; coverage warns." });

// Parallel task item (within a parallel step)
export const ParallelTaskSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String({ description: "Task template with {task}, {previous}, {chain_dir} variables. Defaults to {previous}." })),
	phase: Type.Optional(Type.String({ description: "Optional phase/group label for status and graph rendering." })),
	label: Type.Optional(Type.String({ description: "Optional user-facing label for this parallel task." })),
	as: Type.Optional(Type.String({ description: "Optional safe identifier used as {outputs.name} in later chain steps." })),
	outputSchema: Type.Optional(OutputSchemaOverride),
	cwd: Type.Optional(Type.String()),
	machine: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Herdr saved machine id or label." })),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat this parallel task N times with the same settings." })),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	model: Type.Optional(Type.String({ description: "Override model for this task" })),
	fast: Type.Optional(Type.Boolean({ description: "Opt into priority service tier for supported native OpenAI-Codex child models. This can increase quota or cost." })),
	toolBudget: Type.Optional(ToolBudgetOverride),
	acceptance: Type.Optional(AcceptanceOverride),
	agentContract: Type.Optional(AgentContractOverride),
	gateOn: Type.Optional(ChainGateOverride),
});

export const DynamicExpandSchema = Type.Object({
	from: Type.Object({
		output: Type.String({ description: "Prior named structured output to expand from." }),
		path: Type.String({ description: "JSON Pointer into the structured output, e.g. /items." }),
	}, { additionalProperties: false }),
	item: Type.Optional(Type.String({ description: "Template variable name for each item. Defaults to item." })),
	key: Type.Optional(Type.String({ description: "JSON Pointer relative to each item for stable child ids." })),
	maxItems: Type.Optional(Type.Integer({ minimum: 0, description: "Required fanout bound unless configured globally." })),
	onEmpty: Type.Optional(Type.String({ enum: ["skip", "fail"], description: "Empty input behavior. Defaults to skip." })),
}, { additionalProperties: false });

export const DynamicParallelTemplateSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String({ description: "Task template with {item}, {item.path}, {task}, {previous}, {chain_dir}, and {outputs.name} variables." })),
	phase: Type.Optional(Type.String({ description: "Optional phase/group label for status and graph rendering." })),
	label: Type.Optional(Type.String({ description: "Optional user-facing label; item templates are supported." })),
	outputSchema: Type.Optional(OutputSchemaOverride),
	cwd: Type.Optional(Type.String()),
	machine: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Herdr saved machine id or label." })),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	model: Type.Optional(Type.String({ description: "Override model for this task" })),
	fast: Type.Optional(Type.Boolean({ description: "Opt into priority service tier for supported native OpenAI-Codex child models. This can increase quota or cost." })),
	toolBudget: Type.Optional(ToolBudgetOverride),
	acceptance: Type.Optional(AcceptanceOverride),
	agentContract: Type.Optional(AgentContractOverride),
	gateOn: Type.Optional(ChainGateOverride),
}, { additionalProperties: false });

export const DynamicCollectSchema = Type.Object({
	as: Type.String({ description: "Safe output name for the ordered collected result array." }),
	outputSchema: Type.Optional(JsonSchemaObject),
}, { additionalProperties: false });

// Flattened so chain steps do not need an object-shape anyOf/oneOf union.
export const ChainItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Sequential step agent name" })),
	task: Type.Optional(Type.String({
		description: "Task template with variables: {task}=original request, {previous}=prior step's text response, {chain_dir}=shared folder, {outputs.name}=prior named output. Required for first step, defaults to '{previous}' for subsequent steps."
	})),
	phase: Type.Optional(Type.String({ description: "Optional phase/group label for status and graph rendering." })),
	label: Type.Optional(Type.String({ description: "Optional user-facing label for this chain step." })),
	as: Type.Optional(Type.String({ description: "Optional safe identifier used as {outputs.name} in later chain steps." })),
	outputSchema: Type.Optional(OutputSchemaOverride),
	cwd: Type.Optional(Type.String()),
	machine: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Herdr saved machine id or label." })),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	model: Type.Optional(Type.String({ description: "Override model for this step" })),
	fast: Type.Optional(Type.Boolean({ description: "Opt into priority service tier for supported native OpenAI-Codex child models. This can increase quota or cost." })),
	toolBudget: Type.Optional(ToolBudgetOverride),
	acceptance: Type.Optional(AcceptanceOverride),
	agentContract: Type.Optional(AgentContractOverride),
	gateOn: Type.Optional(ChainGateOverride),
	parallel: Type.Optional(Type.Unsafe({
		anyOf: [
			Type.Array(ParallelTaskSchema, { minItems: 1, description: "Tasks to run in parallel" }),
			DynamicParallelTemplateSchema,
		],
		description: "Static parallel tasks array, or a single dynamic fanout child template when expand/collect are present.",
	})),
	expand: Type.Optional(DynamicExpandSchema),
	collect: Type.Optional(DynamicCollectSchema),
	concurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks (default: 4)" })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop on first failure (default: false)" })),
	worktree: Type.Optional(Type.Boolean({
		description: "Create isolated git worktrees for each parallel task."
	})),
}, {
	description: "Chain step: use {agent, task?, ...} for sequential, {parallel: [...]} for static concurrent execution, or {expand, parallel: {...}, collect} for dynamic fanout.",
	additionalProperties: false,
});

// Runtime mission handlers validate these untrusted nested objects loudly. Keeping
// their provider schema shallow avoids repeating a full durable-record schema in
// every tool request.
const MissionLaunchOverride = Type.Unsafe({
	anyOf: [
		{ type: "object", additionalProperties: true },
		{ type: "boolean" },
	],
});
const MissionUpdateOverride = Type.Unsafe({ type: "object", additionalProperties: true });

const ControlOverrides = Type.Object({
	enabled: Type.Optional(Type.Boolean({ description: "Enable/disable subagent control attention tracking for this run" })),
	needsAttentionAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "No-observed-activity window before a run needs attention" })),
	activeNoticeAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "Active-long-running notice threshold by elapsed ms (default: 240000)" })),
	activeNoticeAfterTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by assistant turns (disabled by default)" })),
	activeNoticeAfterTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by total tokens (disabled by default)" })),
	failedToolAttemptsBeforeAttention: Type.Optional(Type.Integer({ minimum: 1, description: "Consecutive mutating-tool failures before escalating to needs_attention (default: 3)" })),
	notifyOn: Type.Optional(Type.Array(Type.String({ enum: ["active_long_running", "needs_attention"] }), {
		description: "Control event types that should notify the parent/orchestrator. Defaults to active_long_running and needs_attention.",
	})),
	notifyChannels: Type.Optional(Type.Array(Type.String({ enum: ["event", "async", "intercom"] }), {
		description: "Notification channels to use when available. Defaults to event, async, and intercom.",
	})),
});

const SubagentParamProperties = {
	agent: Type.Optional(Type.String({ description: "One-child agent or management target." })),
	task: Type.Optional(Type.String({ description: "One-child task; requires agent." })),
	action: Type.Optional(Type.String({ minLength: 1,
		description: "Management/control only; omit for execution. Only steer, resume, and interrupt are exposed to the model."
	})),
	id: Type.Optional(Type.String({
		description: "Run id/prefix for status/control."
	})),
	message: Type.Optional(Type.String({ description: "resume/steer guidance or project.open prompt." })),
	workflowScript: Type.Optional(Type.String({ minLength: 1, description: "Inline JavaScript statement body; raw/unknown provenance, no runs.host. Use explicit return and top-level await; see tool guidance/guide workflows." })),
	cwd: Type.Optional(Type.String({ description: "Execution/project-pane directory." })),
};

const SubagentParamsSchema = Type.Object(SubagentParamProperties, { additionalProperties: false });

export const SubagentParams = keepTopLevelParameterDescriptions(SubagentParamsSchema);

// Phase 6a: single small public schema. The full/compact branching
// (toCompactSubagentParamsSchema, CompactSubagentParams,
// COMPACT_TOP_LEVEL_DESCRIPTION_KEYS, SubagentParamsProfile) is removed.
