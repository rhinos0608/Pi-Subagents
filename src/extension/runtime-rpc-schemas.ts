/**
 * Strict validators for `subagents:runtime:v1`. Closed shapes:
 * every unknown field is rejected. No TypeBox widening.
 */
import {
	RUNTIME_RPC_BOUNDS,
	RUNTIME_RPC_METHODS,
	RUNTIME_RPC_ROLES,
	type RuntimeRpcMethod,
	type RuntimeRpcV1Request,
	type RuntimeStartV1,
} from "../api/runtime-rpc.ts";

export interface ValidationOk<T> {
	ok: true;
	value: T;
}
export interface ValidationErr {
	ok: false;
	code: "invalid_request" | "invalid_params" | "unsupported_version" | "unsupported_method";
	message: string;
}
export type Validation<T> = ValidationOk<T> | ValidationErr;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;
const MODEL_ID = /^(?![\s\S]*[\x00-\x1f\x7f])[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:+-]+$/;
const RUN_ID = /^runtime_[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) return key;
	}
	return undefined;
}

function checkRequestId(value: unknown): Validation<string> {
	if (typeof value !== "string" || !REQUEST_ID.test(value)) {
		return { ok: false, code: "invalid_request", message: "requestId must match [A-Za-z0-9_-]{1,128}." };
	}
	return { ok: true, value };
}

function checkModelId(value: unknown): Validation<string> {
	if (typeof value !== "string" || value.length === 0 || value.length > RUNTIME_RPC_BOUNDS.maxModelIdLength) {
		return { ok: false, code: "invalid_params", message: "modelId length out of bounds." };
	}
	if (!MODEL_ID.test(value)) {
		return { ok: false, code: "invalid_params", message: "modelId must be exact provider/id without control characters." };
	}
	// Thinking suffixes (`:high` etc.) would silently change the model; reject.
	if (/:off$|:minimal$|:low$|:medium$|:high$|:xhigh$|:max$/.test(value)) {
		return { ok: false, code: "invalid_params", message: "modelId must not carry a thinking suffix." };
	}
	return { ok: true, value };
}

function checkCorrelation(value: unknown): Validation<RuntimeStartV1["correlation"]> {
	if (!isRecord(value)) return { ok: false, code: "invalid_params", message: "correlation must be an object." };
	const bad = exactKeys(value, ["owner", "correlationId", "queryIndex", "role", "stage", "attempt"]);
	if (bad) return { ok: false, code: "invalid_params", message: `Unknown correlation field: ${bad}.` };
	if (value.owner !== "northstar") return { ok: false, code: "invalid_params", message: 'correlation.owner must be "northstar".' };
	if (
		typeof value.correlationId !== "string" ||
		value.correlationId.length === 0 ||
		value.correlationId.length > RUNTIME_RPC_BOUNDS.maxCorrelationIdLength ||
		!ASCII_PRINTABLE.test(value.correlationId)
	) {
		return { ok: false, code: "invalid_params", message: "correlation.correlationId must be bounded ASCII." };
	}
	if (
		typeof value.queryIndex !== "number" ||
		!Number.isInteger(value.queryIndex) ||
		value.queryIndex < 0 ||
		value.queryIndex > RUNTIME_RPC_BOUNDS.maxQueryIndex
	) {
		return { ok: false, code: "invalid_params", message: "correlation.queryIndex out of range." };
	}
	if (typeof value.role !== "string" || !(RUNTIME_RPC_ROLES as readonly string[]).includes(value.role)) {
		return { ok: false, code: "invalid_params", message: "correlation.role must be coverage_planner, researcher, or synthesizer." };
	}
	if (
		typeof value.stage !== "string" ||
		value.stage.length === 0 ||
		value.stage.length > RUNTIME_RPC_BOUNDS.maxStageLength ||
		!ASCII_PRINTABLE.test(value.stage)
	) {
		return { ok: false, code: "invalid_params", message: "correlation.stage must be bounded ASCII." };
	}
	if (
		typeof value.attempt !== "number" ||
		!Number.isInteger(value.attempt) ||
		value.attempt < 0 ||
		value.attempt > RUNTIME_RPC_BOUNDS.maxAttempt
	) {
		return { ok: false, code: "invalid_params", message: "correlation.attempt out of range." };
	}
	return {
		ok: true,
		value: {
			owner: "northstar",
			correlationId: value.correlationId,
			queryIndex: value.queryIndex,
			role: value.role as RuntimeStartV1["correlation"]["role"],
			stage: value.stage,
			attempt: value.attempt,
		},
	};
}

function checkStartParams(value: unknown): Validation<RuntimeStartV1> {
	if (!isRecord(value)) return { ok: false, code: "invalid_params", message: "start params must be an object." };
	const bad = exactKeys(value, ["modelId", "prompt", "maxOutputTokens", "timeoutMs", "outputSchema", "correlation"]);
	if (bad) return { ok: false, code: "invalid_params", message: `Unknown start field: ${bad}.` };
	const model = checkModelId(value.modelId);
	if (!model.ok) return model;
	if (
		typeof value.prompt !== "string" ||
		value.prompt.length === 0 ||
		Buffer.byteLength(value.prompt, "utf8") > RUNTIME_RPC_BOUNDS.maxPromptBytes
	) {
		return { ok: false, code: "invalid_params", message: "prompt must be non-empty within byte limit." };
	}
	if (
		typeof value.maxOutputTokens !== "number" ||
		!Number.isInteger(value.maxOutputTokens) ||
		value.maxOutputTokens < 1 ||
		value.maxOutputTokens > RUNTIME_RPC_BOUNDS.maxNegotiatedOutputTokens
	) {
		return { ok: false, code: "invalid_params", message: "maxOutputTokens out of range." };
	}
	if (
		typeof value.timeoutMs !== "number" ||
		!Number.isInteger(value.timeoutMs) ||
		value.timeoutMs < RUNTIME_RPC_BOUNDS.minTimeoutMs ||
		value.timeoutMs > RUNTIME_RPC_BOUNDS.maxTimeoutMs
	) {
		return { ok: false, code: "invalid_params", message: "timeoutMs out of range." };
	}
	if (value.outputSchema !== undefined && !isRecord(value.outputSchema)) {
		return { ok: false, code: "invalid_params", message: "outputSchema must be an object when present." };
	}
	const correlation = checkCorrelation(value.correlation);
	if (!correlation.ok) return correlation;
	return {
		ok: true,
		value: {
			modelId: model.value,
			prompt: value.prompt,
			maxOutputTokens: value.maxOutputTokens,
			timeoutMs: value.timeoutMs,
			...(value.outputSchema !== undefined ? { outputSchema: value.outputSchema } : {}),
			correlation: correlation.value,
		},
	};
}

export function validateRuntimeRequest(raw: unknown): Validation<RuntimeRpcV1Request> {
	if (!isRecord(raw)) return { ok: false, code: "invalid_request", message: "Runtime request must be an object." };
	const envelopeBad = exactKeys(raw, ["version", "requestId", "method", "params"]);
	if (envelopeBad) return { ok: false, code: "invalid_request", message: `Unknown envelope field: ${envelopeBad}.` };
	if (raw.version !== 1) return { ok: false, code: "unsupported_version", message: "Unsupported runtime version." };
	const id = checkRequestId(raw.requestId);
	if (!id.ok) return id;
	if (typeof raw.method !== "string" || !(RUNTIME_RPC_METHODS as readonly string[]).includes(raw.method)) {
		return { ok: false, code: "unsupported_method", message: "Unsupported runtime method." };
	}
	const method = raw.method as RuntimeRpcMethod;
	const params = raw.params;
	if (method === "negotiate") {
		if (!isRecord(params)) return { ok: false, code: "invalid_params", message: "negotiate params must be an object." };
		const bad = exactKeys(params, ["modelId"]);
		if (bad) return { ok: false, code: "invalid_params", message: `Unknown negotiate field: ${bad}.` };
		const model = checkModelId(params.modelId);
		if (!model.ok) return model;
		return { ok: true, value: { version: 1, requestId: id.value, method, params: { modelId: model.value } } };
	}
	if (method === "start") {
		const start = checkStartParams(params);
		if (!start.ok) return start;
		return { ok: true, value: { version: 1, requestId: id.value, method, params: start.value } };
	}
	if (method === "status" || method === "result") {
		if (!isRecord(params)) return { ok: false, code: "invalid_params", message: `${method} params must be an object.` };
		const bad = exactKeys(params, ["runId"]);
		if (bad) return { ok: false, code: "invalid_params", message: `Unknown ${method} field: ${bad}.` };
		if (typeof params.runId !== "string" || !RUN_ID.test(params.runId)) {
			return { ok: false, code: "invalid_params", message: "runId must be an opaque runtime_ ID." };
		}
		return { ok: true, value: { version: 1, requestId: id.value, method, params: { runId: params.runId } } };
	}
	// cancelAndSettle
	if (!isRecord(params)) return { ok: false, code: "invalid_params", message: "cancelAndSettle params must be an object." };
	const bad = exactKeys(params, ["runIds", "settlementWindowMs"]);
	if (bad) return { ok: false, code: "invalid_params", message: `Unknown cancelAndSettle field: ${bad}.` };
	if (
		!Array.isArray(params.runIds) ||
		params.runIds.length === 0 ||
		params.runIds.length > RUNTIME_RPC_BOUNDS.maxCancelRunIds ||
		!params.runIds.every((entry) => typeof entry === "string" && RUN_ID.test(entry))
	) {
		return { ok: false, code: "invalid_params", message: "runIds must be 1-64 opaque runtime_ IDs." };
	}
	if (new Set(params.runIds).size !== params.runIds.length) {
		return { ok: false, code: "invalid_params", message: "runIds must be duplicate-free." };
	}
	if (
		typeof params.settlementWindowMs !== "number" ||
		!Number.isInteger(params.settlementWindowMs) ||
		params.settlementWindowMs < RUNTIME_RPC_BOUNDS.minSettlementWindowMs ||
		params.settlementWindowMs > RUNTIME_RPC_BOUNDS.maxSettlementWindowMs
	) {
		return { ok: false, code: "invalid_params", message: "settlementWindowMs must be 1-10000ms." };
	}
	return {
		ok: true,
		value: {
			version: 1,
			requestId: id.value,
			method,
			params: { runIds: params.runIds as string[], settlementWindowMs: params.settlementWindowMs },
		},
	};
}

/** Request IDs that cannot be routed safely: ignore without side effects. */
export function safeRuntimeRequestId(raw: unknown): string | undefined {
	if (!isRecord(raw)) return undefined;
	return typeof raw.requestId === "string" && REQUEST_ID.test(raw.requestId) ? raw.requestId : undefined;
}
