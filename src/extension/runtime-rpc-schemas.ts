/**
 * Strict validators for `subagents:runtime:v1`. Closed shapes:
 * every unknown field is rejected. No TypeBox widening.
 */
import {
	RUNTIME_RPC_BOUNDS,
	RUNTIME_RPC_CORRELATION_V2_OWNER_PATTERN,
	RUNTIME_RPC_CORRELATION_V2_ROLE_PATTERN,
	RUNTIME_RPC_JSON_SCHEMA_DIALECTS,
	RUNTIME_RPC_METHODS,
	RUNTIME_RPC_ROLES,
	type RuntimeCorrelation,
	type RuntimeJsonSchemaDialect,
	type RuntimeRpcMethod,
	type RuntimeRpcRole,
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

function checkCorrelation(value: unknown): Validation<RuntimeCorrelation> {
	if (!isRecord(value)) return { ok: false, code: "invalid_params", message: "correlation must be an object." };
	if (value.correlationVersion === undefined) return checkCorrelationV1(value);
	if (value.correlationVersion === 1) return checkCorrelationV1(value);
	if (value.correlationVersion === 2) return checkCorrelationV2(value);
	return { ok: false, code: "invalid_params", message: "correlation.correlationVersion must be 1 or 2 when present." };
}

/** v1: exactly today's key set and rules; explicit correlationVersion: 1 is accepted and echoed. */
function checkCorrelationV1(value: Record<string, unknown>): Validation<RuntimeCorrelation> {
	const bad = exactKeys(value, ["correlationVersion", "owner", "correlationId", "queryIndex", "role", "stage", "attempt"]);
	if (bad) return { ok: false, code: "invalid_params", message: `Unknown correlation field: ${bad}.` };
	if (value.correlationVersion !== undefined && value.correlationVersion !== 1) {
		return { ok: false, code: "invalid_params", message: "correlation.correlationVersion must be 1 or 2 when present." };
	}
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
			...(value.correlationVersion === 1 ? { correlationVersion: 1 as const } : {}),
			owner: "northstar",
			correlationId: value.correlationId,
			queryIndex: value.queryIndex,
			role: value.role as RuntimeRpcRole,
			stage: value.stage,
			attempt: value.attempt,
		},
	};
}

/** outputSchema bounds: byte cap matches prompt bounds; depth/key caps mirror record-validator conventions (reject, never clamp). */
const MAX_OUTPUT_SCHEMA_DEPTH = 10;
const MAX_OUTPUT_SCHEMA_KEYS = 256;
const MAX_OUTPUT_SCHEMA_KEY_LENGTH = 128;

/** Flat-v1 shape: exactly the session flat-primitive rules (mirror of leaf-model-session.ts). */
const FLAT_SCHEMA_KEYS = ["type", "required", "properties", "additionalProperties", "title", "description"];
const FLAT_PROPERTY_KEYS = ["type", "description", "title", "enum"];
const FLAT_PRIMITIVE_TYPES = ["string", "number", "integer", "boolean"];

/** Structured-v1 shape: bounded nested subset. */
const STRUCTURED_SCHEMA_KEYS = ["type", "properties", "required", "items", "enum", "minimum", "maximum", "additionalProperties", "title", "description"];
const STRUCTURED_TYPES = ["object", "array", "string", "number", "integer", "boolean"];

function checkFlatSchemaShape(value: Record<string, unknown>): Validation<Record<string, unknown>> {
	const message = "outputSchema is not a supported flat object schema.";
	const fail = (): Validation<Record<string, unknown>> => ({ ok: false, code: "invalid_params", message });
	for (const key of Object.keys(value)) {
		if (!FLAT_SCHEMA_KEYS.includes(key)) return fail();
	}
	if (value.type !== undefined && value.type !== "object") return fail();
	if (value.required !== undefined) {
		if (!Array.isArray(value.required) || value.required.some((entry) => typeof entry !== "string")) return fail();
	}
	if (value.properties !== undefined) {
		if (!isRecord(value.properties)) return fail();
		for (const spec of Object.values(value.properties)) {
			if (!isRecord(spec)) return fail();
			for (const key of Object.keys(spec)) {
				if (!FLAT_PROPERTY_KEYS.includes(key)) return fail();
			}
			if (!FLAT_PRIMITIVE_TYPES.includes(spec.type as string)) return fail();
			if (spec.enum !== undefined && !Array.isArray(spec.enum)) return fail();
		}
	}
	if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") return fail();
	return { ok: true, value };
}

function isStructuredSchemaNode(node: unknown): boolean {
	if (!isRecord(node)) return false;
	for (const key of Object.keys(node)) {
		if (!STRUCTURED_SCHEMA_KEYS.includes(key)) return false;
	}
	if (node.type !== undefined && !STRUCTURED_TYPES.includes(node.type as string)) return false;
	if (node.properties !== undefined) {
		if (!isRecord(node.properties)) return false;
		for (const sub of Object.values(node.properties)) {
			if (!isStructuredSchemaNode(sub)) return false;
		}
	}
	if (node.required !== undefined) {
		if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== "string")) return false;
	}
	if (node.items !== undefined) {
		if (node.type !== undefined && node.type !== "array") return false;
		if (!isStructuredSchemaNode(node.items)) return false;
	}
	if (node.enum !== undefined && !Array.isArray(node.enum)) return false;
	if (node.minimum !== undefined) {
		if (node.type !== undefined && node.type !== "number" && node.type !== "integer") return false;
		if (typeof node.minimum !== "number" || !Number.isFinite(node.minimum)) return false;
	}
	if (node.maximum !== undefined) {
		if (node.type !== undefined && node.type !== "number" && node.type !== "integer") return false;
		if (typeof node.maximum !== "number" || !Number.isFinite(node.maximum)) return false;
	}
	if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") return false;
	return true;
}

function checkOutputSchema(value: unknown, dialect: unknown = "flat-v1"): Validation<Record<string, unknown>> {
	if (!(RUNTIME_RPC_JSON_SCHEMA_DIALECTS as readonly string[]).includes(dialect as string)) {
		return { ok: false, code: "invalid_params", message: "Unknown jsonSchema dialect." };
	}
	if (!isRecord(value)) {
		return { ok: false, code: "invalid_params", message: "outputSchema must be an object when present." };
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? "";
	} catch {
		return { ok: false, code: "invalid_params", message: "outputSchema must be serializable." };
	}
	if (Buffer.byteLength(serialized, "utf8") > RUNTIME_RPC_BOUNDS.maxPromptBytes) {
		return { ok: false, code: "invalid_params", message: "outputSchema exceeds byte limit." };
	}
	let keys = 0;
	const walk = (node: unknown, depth: number): boolean => {
		if (depth > MAX_OUTPUT_SCHEMA_DEPTH) return false;
		if (Array.isArray(node)) {
			for (const entry of node) {
				if (!walk(entry, depth + 1)) return false;
			}
			return true;
		}
		if (isRecord(node)) {
			for (const key of Object.keys(node)) {
				keys += 1;
				if (keys > MAX_OUTPUT_SCHEMA_KEYS) return false;
				if (key.length === 0 || key.length > MAX_OUTPUT_SCHEMA_KEY_LENGTH) return false;
				if (!walk(node[key], depth + 1)) return false;
			}
		}
		return true;
	};
	if (!walk(value, 0)) {
		return { ok: false, code: "invalid_params", message: "outputSchema exceeds depth/key bounds." };
	}
	if ((dialect as RuntimeJsonSchemaDialect) === "structured-v1") {
		if (!isStructuredSchemaNode(value)) {
			return { ok: false, code: "invalid_params", message: "outputSchema is not a supported structured schema." };
		}
		return { ok: true, value };
	}
	if (dialect === undefined || (dialect as RuntimeJsonSchemaDialect) === "flat-v1") return checkFlatSchemaShape(value);
	return { ok: false, code: "invalid_params", message: "Unknown jsonSchema dialect." };
}

/**
 * v2: same closed key set (plus required correlationVersion: 2) and same
 * shared field rules as v1, except owner and role are pattern-matched
 * handles instead of the northstar literal and role enum.
 */
function checkCorrelationV2(value: Record<string, unknown>): Validation<RuntimeCorrelation> {
	const bad = exactKeys(value, ["correlationVersion", "owner", "correlationId", "queryIndex", "role", "stage", "attempt"]);
	if (bad) return { ok: false, code: "invalid_params", message: `Unknown correlation field: ${bad}.` };
	if (typeof value.owner !== "string" || !RUNTIME_RPC_CORRELATION_V2_OWNER_PATTERN.test(value.owner)) {
		return { ok: false, code: "invalid_params", message: "correlation.owner must match the v2 owner pattern." };
	}
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
	if (typeof value.role !== "string" || !RUNTIME_RPC_CORRELATION_V2_ROLE_PATTERN.test(value.role)) {
		return { ok: false, code: "invalid_params", message: "correlation.role must match the v2 role pattern." };
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
			correlationVersion: 2,
			owner: value.owner,
			correlationId: value.correlationId,
			queryIndex: value.queryIndex,
			role: value.role,
			stage: value.stage,
			attempt: value.attempt,
		},
	};
}

function checkStartParams(value: unknown, jsonSchemaDialect: unknown = "flat-v1"): Validation<RuntimeStartV1> {
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
	let outputSchema: Record<string, unknown> | undefined;
	if (value.outputSchema !== undefined) {
		const schema = checkOutputSchema(value.outputSchema, jsonSchemaDialect);
		if (!schema.ok) return schema;
		outputSchema = schema.value;
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
			...(outputSchema !== undefined ? { outputSchema } : {}),
			correlation: correlation.value,
		},
	};
}

export interface RuntimeRequestValidationOptions {
	/** Schema dialect for start outputSchema validation. Defaults to flat-v1; unknown strings reject. */
	jsonSchemaDialect?: unknown;
}

export function validateRuntimeRequest(raw: unknown, options?: RuntimeRequestValidationOptions): Validation<RuntimeRpcV1Request> {
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
		const start = checkStartParams(params, options?.jsonSchemaDialect ?? "flat-v1");
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
