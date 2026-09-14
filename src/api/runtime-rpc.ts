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
	idempotencyTtlMs: 10 * 60 * 1000,
} as const;

/** Exact host versions proven by the native suite. Empty until proven. */
export const VERIFIED_RUNTIME_HOST_VERSIONS: readonly string[] = [];

/** Audited provider APIs. Names alone never imply support. */
export const RUNTIME_RPC_AUDITED_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type RuntimeRpcAuditedApi = (typeof RUNTIME_RPC_AUDITED_APIS)[number];

/** Explicitly rejected APIs. */
export const RUNTIME_RPC_REJECTED_APIS = ["openai-codex-responses"] as const;

export const RUNTIME_RPC_ROLES = ["coverage_planner", "researcher", "synthesizer"] as const;
export type RuntimeRpcRole = (typeof RUNTIME_RPC_ROLES)[number];

/** Closed content-free correlation metadata. No arbitrary fields. */
export interface RuntimeCorrelationV1 {
	owner: "northstar";
	correlationId: string;
	queryIndex: number;
	role: RuntimeRpcRole;
	stage: string;
	attempt: number;
}

export interface RuntimeStartV1 {
	/** Exact `provider/model` ID. No fuzzy resolution, no thinking suffix, no fallback. */
	modelId: string;
	prompt: string;
	maxOutputTokens: number;
	timeoutMs: number;
	/** Syntactically accepted; semantically rejected while text-only. */
	outputSchema?: Record<string, unknown>;
	correlation: RuntimeCorrelationV1;
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
	outputModes: ["text"];
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
