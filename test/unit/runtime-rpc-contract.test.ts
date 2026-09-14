import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

	it("accepts outputSchema syntactically (semantic rejection is runtime behavior)", () => {
		const result = validateRuntimeRequest({ ...base, requestId: "a", method: "start", params: startParams({ outputSchema: { type: "object" } }) });
		assert.equal(result.ok, true);
	});
});
