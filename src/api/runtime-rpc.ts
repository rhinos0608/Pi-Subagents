/**
 * Portable leaf-model runtime RPC v1 — public contract.
 *
 * Separate namespace from `subagents:rpc:v1`; that namespace is untouched.
 * Northstar remains external and owns public jobs, budgets, and citations.
 * This runtime owns bounded leaf execution only.
 *
 * Trust boundary: `pi.events` is callable by trusted co-installed extension
 * code. `correlation.owner === "northstar"` is correlation metadata, not
 * authentication.
 */

/** Protocol version. Unknown versions fail closed. */
export const RUNTIME_RPC_VERSION = 1;

/** Versioned event namespace. Never reuse the legacy `subagents:rpc:v1` names. */
export const RUNTIME_RPC_PROTOCOL = "subagents:runtime:v1";
export const RUNTIME_RPC_READY_EVENT = "subagents:runtime:v1:ready";
export const RUNTIME_RPC_REQUEST_EVENT = "subagents:runtime:v1:request";
export const RUNTIME_RPC_REPLY_EVENT_PREFIX = "subagents:runtime:v1:reply:";

export const RUNTIME_RPC_METHODS = ["negotiate", "start", "status", "result", "cancelAndSettle"] as const;
export type RuntimeRpcMethod = (typeof RUNTIME_RPC_METHODS)[number];

export function runtimeRpcReplyEvent(requestId: string): string {
	return `${RUNTIME_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}

/** Server-side bounds. Exported so future revisions stay explicit. */
export const RUNTIME_RPC_BOUNDS = {
	maxParallelRuns: 4,
	maxResultBytes: 262_144,
	maxPromptBytes: 262_144,
	maxTimeoutMs: 600_000,
	minTimeoutMs: 1,
	maxCancelRunIds: 64,
	minSettlementWindowMs: 1,
	maxSettlementWindowMs: 10_000,
	resultRetentionMs: 10 * 60 * 1000,
	retainedResultMemoryBytes: 32 * 1024 * 1024,
	maxRequestIdLength: 128,
	maxModelIdLength: 256,
	maxCorrelationIdLength: 128,
	maxStageLength: 64,
	maxQueryIndex: 1_000_000,
	maxAttempt: 1_000,
	/** Minimum output tokens for OpenAI Responses; requests below fail, never widen. */
	minResponsesOutputTokens: 16,
	/** Server ceiling for negotiated output tokens. Effective max is min(server, model). */
	maxNegotiatedOutputTokens: 16_384,
	/** Bounded idempotency records for duplicate request-ID defense. */
	maxIdempotencyRecords: 512,
	/** Bounded per-model negotiation state (negotiatedModels + negotiatedJsonSchema).
	 * Oldest-evicted on overflow; re-negotiation re-admits. Follows the
	 * maxIdempotencyRecords oldest-eviction pattern. */
	maxNegotiatedModels: 256,
	idempotencyTtlMs: 10 * 60 * 1000,
} as const;

/**
 * Exact host versions proven by the native suite
 * (`test/unit/runtime-rpc-native-host.test.ts` runs one real prompt
 * end-to-end against each listed install). Unlisted versions stay
 * fail-closed. Each entry rides proof: the native suite fails when the
 * real SDK version it finds is not listed here.
 */
export const VERIFIED_RUNTIME_HOST_VERSIONS: readonly string[] = ["0.85.1"];

/** Audited provider APIs. Names alone never imply support. */
export const RUNTIME_RPC_AUDITED_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type RuntimeRpcAuditedApi = (typeof RUNTIME_RPC_AUDITED_APIS)[number];

/** Explicitly rejected APIs. */
export const RUNTIME_RPC_REJECTED_APIS = ["openai-codex-responses"] as const;

export const RUNTIME_RPC_ROLES = ["coverage_planner", "researcher", "synthesizer"] as const;
export type RuntimeRpcRole = (typeof RUNTIME_RPC_ROLES)[number];

/** Role registry export for consumers: the known v1 roles, also advertised via negotiate correlationV2. */
export const RUNTIME_RPC_ROLE_REGISTRY: readonly RuntimeRpcRole[] = RUNTIME_RPC_ROLES;

/** Supported leaf output modes. Additive: consumers must use membership checks, never exact equality. */
export const RUNTIME_RPC_OUTPUT_MODES = ["text", "json"] as const;
export type RuntimeOutputMode = (typeof RUNTIME_RPC_OUTPUT_MODES)[number];

/** Supported JSON schema dialects. Additive: consumers must use membership checks, never exact equality. */
export const RUNTIME_RPC_JSON_SCHEMA_DIALECTS = ["flat-v1", "structured-v1"] as const;
export type RuntimeJsonSchemaDialect = (typeof RUNTIME_RPC_JSON_SCHEMA_DIALECTS)[number];

/** Correlation protocol versions. 1 is the closed northstar shape; 2 opens owner/role by pattern. */
export const RUNTIME_RPC_CORRELATION_VERSIONS = [1, 2] as const;
export type RuntimeCorrelationVersion = (typeof RUNTIME_RPC_CORRELATION_VERSIONS)[number];

/** v2 owner handle: lowercase start, 3-32 chars of lowercase/digit/underscore/hyphen. */
export const RUNTIME_RPC_CORRELATION_V2_OWNER_PATTERN = /^[a-z][a-z0-9_-]{2,31}$/;
/** v2 role handle: lowercase start, up to 48 chars of lowercase/digit/underscore. */
export const RUNTIME_RPC_CORRELATION_V2_ROLE_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/** Closed content-free correlation metadata. No arbitrary fields. */
export interface RuntimeCorrelationV1 {
	correlationVersion?: 1;
	owner: "northstar";
	correlationId: string;
	queryIndex: number;
	role: RuntimeRpcRole;
	stage: string;
	attempt: number;
}

/**
 * Correlation v2: same closed shape and field rules as v1, except owner and
 * role are open handles matched by pattern (not the northstar literal / role
 * enum). Discriminated by required correlationVersion: 2.
 */
export interface RuntimeCorrelationV2 {
	correlationVersion: 2;
	owner: string;
	correlationId: string;
	queryIndex: number;
	role: string;
	stage: string;
	attempt: number;
}

/** Correlation union discriminated by correlationVersion (absent means 1). */
export type RuntimeCorrelation = RuntimeCorrelationV1 | RuntimeCorrelationV2;

export interface RuntimeStartV1 {
	/** Exact `provider/model` ID. No fuzzy resolution, no thinking suffix, no fallback. */
	modelId: string;
	prompt: string;
	maxOutputTokens: number;
	timeoutMs: number;
	/** Present selects JSON mode: output carries JSON-as-text validated against this schema. */
	outputSchema?: Record<string, unknown>;
	/** Bridge-injected only (never on the wire: the start gate rejects unknown
	 * fields): the per-model negotiated JSON schema dialect. Present only when
	 * outputSchema is present; absent means flat-v1. */
	outputSchemaDialect?: RuntimeJsonSchemaDialect;
	correlation: RuntimeCorrelation;
}

export type RuntimeRpcV1Request =
	| { version: 1; requestId: string; method: "negotiate"; params: { modelId: string } }
	| { version: 1; requestId: string; method: "start"; params: RuntimeStartV1 }
	| { version: 1; requestId: string; method: "status"; params: { runId: string } }
	| { version: 1; requestId: string; method: "result"; params: { runId: string } }
	| {
			version: 1;
			requestId: string;
			method: "cancelAndSettle";
			params: { runIds: string[]; settlementWindowMs: number };
	  };

/**
 * Advertised v2 correlation support. Additive and optional: v1-only consumers
 * ignore it. ownerPattern is the source of the v2 owner regex; roles lists
 * the known role registry (v2 roles additionally match the role pattern).
 */
export interface RuntimeCorrelationV2Capability {
	ownerPattern: string;
	roles: readonly string[];
}

export interface RuntimeCapabilitiesV1 {
	boundedCancellationSettlement: true;
	leafOnlyExecution: true;
	exactModelSelection: true;
	maxOutputTokensEnforced: true;
	backgroundExecution: true;
	maxParallelRuns: number;
	maxResultBytes: number;
	minOutputTokens: number;
	maxOutputTokens: number;
	outputModes: readonly RuntimeOutputMode[];
	correlationV2?: RuntimeCorrelationV2Capability;
	/** Advertised JSON schema dialect. Additive and optional: v1-only consumers
	 * ignore it. Absent means flat-v1 semantics. */
	jsonSchema?: RuntimeJsonSchemaDialect;
}

export interface RuntimeNegotiateOk {
	compatible: true;
	modelId: string;
	capabilities: RuntimeCapabilitiesV1;
}

export type RuntimeRunState = "running" | "completed" | "failed" | "cancelled";

export interface RuntimeStartOk {
	runId: string;
	state: "running";
}

export interface RuntimeStatusOk {
	runId: string;
	state: RuntimeRunState;
	startedAt: number;
	updatedAt: number;
}

export interface RuntimeResultOk {
	runId: string;
	state: "completed";
	output: string;
	outputTokens: number;
	truncated: boolean;
}

export interface RuntimeCancelSettlement {
	runId: string;
	state: "completed" | "failed" | "cancelled";
}

export interface RuntimeCancelAndSettleOk {
	settlements: RuntimeCancelSettlement[];
}

export type RuntimeRpcErrorCode =
	| "invalid_request"
	| "invalid_params"
	| "unsupported_version"
	| "unsupported_method"
	| "duplicate_request_id"
	| "runtime_unavailable"
	| "unsupported_capability"
	| "capacity_exceeded"
	| "not_found"
	| "invalid_state"
	| "model_unavailable"
	| "provider_error"
	| "timeout"
	| "output_token_limit_exceeded"
	| "result_byte_limit_exceeded"
	| "output_contract_breach"
	| "contract_breach";

export type RuntimeRpcReply =
	| { version: 1; requestId: string; method: RuntimeRpcMethod; success: true; data: unknown }
	| {
			version: 1;
			requestId: string;
			method?: RuntimeRpcMethod;
			success: false;
			error: { code: RuntimeRpcErrorCode; message: string };
	  };

/** Fixed safe messages. Never forward provider exception text. */
export const RUNTIME_RPC_ERROR_MESSAGES: Record<RuntimeRpcErrorCode, string> = {
	invalid_request: "Malformed runtime request.",
	invalid_params: "Invalid runtime params.",
	unsupported_version: "Unsupported runtime version.",
	unsupported_method: "Unsupported runtime method.",
	duplicate_request_id: "Duplicate runtime request ID.",
	runtime_unavailable: "Leaf runtime unavailable on this host.",
	unsupported_capability: "Model or capability unsupported by leaf runtime.",
	capacity_exceeded: "Leaf runtime at capacity.",
	not_found: "Runtime run not found.",
	invalid_state: "Runtime run is not in a state for that operation.",
	model_unavailable: "Exact model unavailable.",
	provider_error: "Provider execution failed.",
	timeout: "Leaf run timed out.",
	output_token_limit_exceeded: "Reported output tokens exceed requested cap.",
	result_byte_limit_exceeded: "Result payload exceeds byte limit.",
	output_contract_breach: "Provider output violated leaf contract.",
	contract_breach: "Cancellation settlement breached; runtime unhealthy.",
};
