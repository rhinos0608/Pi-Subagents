import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RUNTIME_RPC_JSON_SCHEMA_DIALECTS } from "../../src/api/runtime-rpc.ts";
import { validateRuntimeRequest } from "../../src/extension/runtime-rpc-schemas.ts";

const base = { version: 1 as const };

function startParams(overrides: Record<string, unknown> = {}) {
	return {
		modelId: "openai/gpt-5-mini",
		prompt: "Summarize.",
		maxOutputTokens: 256,
		timeoutMs: 60_000,
		correlation: {
			owner: "northstar",
			correlationId: "corr-1",
			queryIndex: 0,
			role: "researcher",
			stage: "plan",
			attempt: 0,
		},
		...overrides,
	};
}

describe("runtime RPC contract schemas", () => {
	it("accepts each method envelope", () => {
		assert.equal(validateRuntimeRequest({ ...base, requestId: "a", method: "negotiate", params: { modelId: "openai/gpt-5-mini" } }).ok, true);
		assert.equal(validateRuntimeRequest({ ...base, requestId: "b", method: "start", params: startParams() }).ok, true);
		assert.equal(validateRuntimeRequest({ ...base, requestId: "c", method: "status", params: { runId: "runtime_abc" } }).ok, true);
		assert.equal(validateRuntimeRequest({ ...base, requestId: "d", method: "result", params: { runId: "runtime_abc" } }).ok, true);
		assert.equal(
			validateRuntimeRequest({ ...base, requestId: "e", method: "cancelAndSettle", params: { runIds: ["runtime_abc"], settlementWindowMs: 1000 } }).ok,
			true,
		);
	});

	it("rejects unknown fields at every level", () => {
		const envelope = validateRuntimeRequest({ ...base, requestId: "a", method: "ping", params: {}, cwd: "/tmp" });
		assert.equal(envelope.ok, false);
		const start = validateRuntimeRequest({ ...base, requestId: "a", method: "start", params: startParams({ tools: [] }) });
		assert.equal(start.ok, false);
		if (!start.ok) assert.match(start.message, /Unknown start field/);
		const correlation = validateRuntimeRequest({ ...base, requestId: "a", method: "start", params: startParams({ correlation: { owner: "northstar", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0, jobId: "public-1" } }) });
		assert.equal(correlation.ok, false);
	});

	it("rejects malformed IDs and control characters", () => {
		assert.equal(validateRuntimeRequest({ ...base, requestId: "bad\nid", method: "negotiate", params: { modelId: "openai/x" } }).ok, false);
		const model = validateRuntimeRequest({ ...base, requestId: "a", method: "negotiate", params: { modelId: "fuzzy-alias" } });
		assert.equal(model.ok, false);
		const suffix = validateRuntimeRequest({ ...base, requestId: "a", method: "negotiate", params: { modelId: "openai/gpt-5:high" } });
		assert.equal(suffix.ok, false);
		const run = validateRuntimeRequest({ ...base, requestId: "a", method: "status", params: { runId: "async-123" } });
		assert.equal(run.ok, false);
	});

	it("enforces closed correlation enums and ranges", () => {
		const owner = validateRuntimeRequest({ ...base, requestId: "a", method: "start", params: startParams({ correlation: { owner: "anyone", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0 } }) });
		assert.equal(owner.ok, false);
		const role = validateRuntimeRequest({ ...base, requestId: "a", method: "start", params: startParams({ correlation: { owner: "northstar", correlationId: "c", queryIndex: 0, role: "admin", stage: "s", attempt: 0 } }) });
		assert.equal(role.ok, false);
		const dup = validateRuntimeRequest({ ...base, requestId: "a", method: "cancelAndSettle", params: { runIds: ["runtime_x", "runtime_x"], settlementWindowMs: 100 } });
		assert.equal(dup.ok, false);
		const window = validateRuntimeRequest({ ...base, requestId: "a", method: "cancelAndSettle", params: { runIds: ["runtime_x"], settlementWindowMs: 10_001 } });
		assert.equal(window.ok, false);
	});

	it("rejects wrong version and method unions", () => {
		assert.deepEqual(validateRuntimeRequest({ version: 2, requestId: "a", method: "status", params: { runId: "runtime_x" } }).ok, false);
		const method = validateRuntimeRequest({ ...base, requestId: "a", method: "spawn", params: {} });
		assert.equal(method.ok, false);
		if (!method.ok) assert.equal(method.code, "unsupported_method");
	});

	it("accepts outputSchema within bounds, rejects oversize/deep/keycount with invalid_params", () => {
		const good = validateRuntimeRequest({ ...base, requestId: "a", method: "start", params: startParams({ outputSchema: { type: "object" } }) });
		assert.equal(good.ok, true);
		const nonObject = validateRuntimeRequest({ ...base, requestId: "b", method: "start", params: startParams({ outputSchema: ["array"] }) });
		assert.equal(nonObject.ok, false);
		if (!nonObject.ok) assert.equal(nonObject.code, "invalid_params");
		const oversize = validateRuntimeRequest({ ...base, requestId: "c", method: "start", params: startParams({ outputSchema: { blob: "x".repeat(262_145) } }) });
		assert.equal(oversize.ok, false);
		if (!oversize.ok) {
			assert.equal(oversize.code, "invalid_params");
			assert.match(oversize.message, /byte limit/);
		}
		let deep: Record<string, unknown> = { leaf: "x" };
		for (let depth = 0; depth < 11; depth += 1) deep = { nested: deep };
		const tooDeep = validateRuntimeRequest({ ...base, requestId: "d", method: "start", params: startParams({ outputSchema: deep }) });
		assert.equal(tooDeep.ok, false);
		if (!tooDeep.ok) {
			assert.equal(tooDeep.code, "invalid_params");
			assert.match(tooDeep.message, /depth\/key bounds/);
		}
		const manyKeys: Record<string, unknown> = {};
		for (let index = 0; index < 257; index += 1) manyKeys[`k${index}`] = index;
		const tooMany = validateRuntimeRequest({ ...base, requestId: "e", method: "start", params: startParams({ outputSchema: manyKeys }) });
		assert.equal(tooMany.ok, false);
		if (!tooMany.ok) {
			assert.equal(tooMany.code, "invalid_params");
			assert.match(tooMany.message, /depth\/key bounds/);
		}
	});

	it("structured-v1 dialect accepts bounded nested schemas; flat-v1 rejects them", () => {
		const structuredSchema = {
			type: "object",
			required: ["questions", "total"],
			properties: {
				questions: {
					type: "array",
					items: {
						type: "object",
						required: ["query"],
						properties: {
							query: { type: "string" },
							priority: { type: "integer", minimum: 1, maximum: 5 },
							route: { type: "string", enum: ["web", "research", "github"] },
							limit: { type: "number", minimum: 0 },
						},
						additionalProperties: false,
					},
				},
				total: { type: "integer", minimum: 0 },
			},
			additionalProperties: false,
		};
		const check = (requestId: string, schema: Record<string, unknown>, dialect?: unknown) =>
			validateRuntimeRequest(
				{ ...base, requestId, method: "start", params: startParams({ outputSchema: schema }) },
				dialect === undefined ? undefined : { jsonSchemaDialect: dialect },
			);
		assert.equal(check("s1", structuredSchema, "structured-v1").ok, true);
		const flat = check("s2", structuredSchema, "flat-v1");
		assert.equal(flat.ok, false);
		if (!flat.ok) assert.equal(flat.code, "invalid_params");
		assert.equal(check("s3", structuredSchema).ok, false);
		const unknown = check("s4", structuredSchema, "nested-v9");
		assert.equal(unknown.ok, false);
		if (!unknown.ok) {
			assert.equal(unknown.code, "invalid_params");
			assert.match(unknown.message, /Unknown jsonSchema dialect/);
		}
	});

	it("structured-v1 still rejects over-deep/over-key/over-byte and unsupported shapes", () => {
		const check = (requestId: string, schema: unknown) =>
			validateRuntimeRequest(
				{ ...base, requestId, method: "start", params: startParams({ outputSchema: schema }) },
				{ jsonSchemaDialect: "structured-v1" },
			);
		let deep: Record<string, unknown> = { leaf: "x" };
		for (let depth = 0; depth < 11; depth += 1) deep = { nested: deep };
		const tooDeep = check("sd", deep);
		assert.equal(tooDeep.ok, false);
		if (!tooDeep.ok) {
			assert.equal(tooDeep.code, "invalid_params");
			assert.match(tooDeep.message, /depth\/key bounds/);
		}
		const manyKeys: Record<string, unknown> = {};
		for (let index = 0; index < 257; index += 1) manyKeys[`k${index}`] = index;
		assert.equal(check("sk", manyKeys).ok, false);
		assert.equal(check("sb", { blob: "x".repeat(262_145) }).ok, false);
		for (const [id, schema] of [
			["sref", { $ref: "#/defs/x" }],
			["stype", { type: "date" }],
			["sitems", { type: "object", properties: { list: { items: "nope" } } }],
		] as const) {
			const result = check(id, schema);
			assert.equal(result.ok, false, id);
			if (!result.ok) {
				assert.equal(result.code, "invalid_params", id);
				assert.match(result.message, /not a supported structured schema/, id);
			}
		}
	});

	it("flat fixtures pass unchanged under explicit flat-v1", () => {
		assert.deepEqual([...RUNTIME_RPC_JSON_SCHEMA_DIALECTS], ["flat-v1", "structured-v1"]);
		const flatSchema = {
			type: "object",
			required: ["summary"],
			properties: { summary: { type: "string" }, count: { type: "integer", enum: [1, 2, 3] } },
		};
		assert.equal(
			validateRuntimeRequest(
				{ ...base, requestId: "f1", method: "start", params: startParams({ outputSchema: flatSchema }) },
				{ jsonSchemaDialect: "flat-v1" },
			).ok,
			true,
		);
		assert.equal(
			validateRuntimeRequest({ ...base, requestId: "f2", method: "start", params: startParams({ outputSchema: { type: "object" } }) }).ok,
			true,
		);
	});

	it("echoes explicit correlationVersion: 1 and aligns the unknown-version message", () => {
		const explicit = validateRuntimeRequest({
			...base,
			requestId: "v1",
			method: "start",
			params: startParams({ correlation: { correlationVersion: 1, owner: "northstar", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0 } }),
		});
		assert.equal(explicit.ok, true);
		if (explicit.ok) assert.deepEqual(explicit.value.params.correlation, { correlationVersion: 1, owner: "northstar", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0 });
		const implicit = validateRuntimeRequest({ ...base, requestId: "v1b", method: "start", params: startParams() });
		assert.equal(implicit.ok, true);
		if (implicit.ok) assert.ok(!("correlationVersion" in implicit.value.params.correlation));
		const unknown = validateRuntimeRequest({
			...base,
			requestId: "v9",
			method: "start",
			params: startParams({ correlation: { correlationVersion: 3, owner: "northstar", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0 } }),
		});
		assert.equal(unknown.ok, false);
		if (!unknown.ok) {
			assert.equal(unknown.code, "invalid_params");
			assert.equal(unknown.message, "correlation.correlationVersion must be 1 or 2 when present.");
		}
	});
});
