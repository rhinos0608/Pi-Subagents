import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	RUNTIME_RPC_BOUNDS,
	RUNTIME_RPC_CORRELATION_V2_OWNER_PATTERN,
	RUNTIME_RPC_CORRELATION_V2_ROLE_PATTERN,
	RUNTIME_RPC_JSON_SCHEMA_DIALECTS,
	RUNTIME_RPC_OUTPUT_MODES,
	RUNTIME_RPC_ROLE_REGISTRY,
	RUNTIME_RPC_ROLES,
	runtimeRpcReplyEvent,
	RUNTIME_RPC_REQUEST_EVENT,
	VERIFIED_RUNTIME_HOST_VERSIONS,
} from "../../src/api/runtime-rpc.ts";
import { validateRuntimeRequest } from "../../src/extension/runtime-rpc-schemas.ts";
import { registerRuntimeRpcBridge } from "../../src/extension/runtime-rpc.ts";
import { LeafModelRuntime } from "../../src/runs/runtime/leaf-model-runtime.ts";
import { executeLeafRun, LeafFailure, type LeafHost } from "../../src/runs/runtime/leaf-model-session.ts";
import type { ModelInfo } from "../../src/shared/model-info.ts";

const MODELS: ModelInfo[] = [
	{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", api: "openai-responses", maxTokens: 8192 },
];

function fakeHost(text: string): LeafHost {
	return {
		hostVersion: "9.9.9-verified-test",
		listModels: () => MODELS,
		createLeafSession: async () => ({
			prompt: async () => ({ text, outputTokens: 10, toolCalls: 0, providerInvocations: 1 }),
			abort: async () => {},
			waitForIdle: async () => {},
			dispose: async () => {},
		}),
	};
}

const JSON_SCHEMA = {
	type: "object",
	required: ["summary"],
	properties: { summary: { type: "string" }, count: { type: "integer" } },
};

function jsonParams(text: string, schema: Record<string, unknown> = JSON_SCHEMA, dialect?: "flat-v1" | "structured-v1") {
	return { modelId: "openai/gpt-5-mini", prompt: "hi", maxOutputTokens: 256, cwd: "/r", outputSchema: schema, ...(dialect !== undefined ? { outputSchemaDialect: dialect } : {}) };
}

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

const base = { version: 1 as const };

class FakeEvents {
	readonly emitted: Array<{ event: string; data: unknown }> = [];
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => {
			this.handlers.set(event, (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
		};
	}

	emit(event: string, data: unknown): void {
		this.emitted.push({ event, data });
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}
}

function request(events: FakeEvents, requestId: string, method: string, params?: unknown): Promise<unknown> {
	return new Promise((resolve) => {
		const unsubscribe = events.on(runtimeRpcReplyEvent(requestId), (payload) => {
			unsubscribe();
			resolve(payload);
		});
		events.emit(RUNTIME_RPC_REQUEST_EVENT, { version: 1, requestId, method, ...(params !== undefined ? { params } : {}) });
	});
}

describe("leaf runtime contract extensions", () => {
	it("JSON mode happy path keeps the envelope shape with JSON-as-text output", async () => {
		const text = JSON.stringify({ summary: "done", count: 3 });
		const result = await executeLeafRun(fakeHost(text), jsonParams(text));
		assert.deepEqual(result, { output: text, outputTokens: 10 });
	});

	it("JSON parse failure maps to output_contract_breach with a fixed message", async () => {
		await assert.rejects(
			executeLeafRun(fakeHost("not json {"), jsonParams("not json {")),
			(error: unknown) =>
				error instanceof LeafFailure &&
				error.code === "output_contract_breach" &&
				error.message === "Leaf run output is not valid JSON.",
		);
	});

	it("JSON schema violation maps to output_contract_breach with a fixed message", async () => {
		const missing = JSON.stringify({ count: 3 });
		await assert.rejects(
			executeLeafRun(fakeHost(missing), jsonParams(missing)),
			(error: unknown) =>
				error instanceof LeafFailure &&
				error.code === "output_contract_breach" &&
				error.message === "Leaf run output failed schema validation.",
		);
		const wrongType = JSON.stringify({ summary: "done", count: "three" });
		await assert.rejects(
			executeLeafRun(fakeHost(wrongType), jsonParams(wrongType)),
			(error: unknown) => error instanceof LeafFailure && error.code === "output_contract_breach",
		);
	});

	it("unsupported schemas fail closed without interpreting partial output", async () => {
		const text = JSON.stringify({ summary: "done" });
		for (const schema of [
			{ $ref: "#/defs/x" },
			{ type: "object", properties: { nested: { type: "object", properties: { a: { type: "string" } } } } },
			{ type: "array", items: { type: "string" } },
		]) {
			await assert.rejects(
				executeLeafRun(fakeHost(text), jsonParams(text, schema)),
				(error: unknown) =>
					error instanceof LeafFailure &&
					error.code === "output_contract_breach" &&
					error.message === "Leaf run outputSchema is not a supported flat object schema.",
			);
		}
	});

	it("plain-text path passes JSON-looking text through untouched without a schema", async () => {
		const text = '{"summary":"raw"}';
		const result = await executeLeafRun(fakeHost(text), { modelId: "openai/gpt-5-mini", prompt: "hi", maxOutputTokens: 256, cwd: "/r" });
		assert.equal(result.output, text);
	});

	it("output modes are advertised as a membership set containing text and json", () => {
		assert.ok((RUNTIME_RPC_OUTPUT_MODES as readonly string[]).includes("text"));
		assert.ok((RUNTIME_RPC_OUTPUT_MODES as readonly string[]).includes("json"));
		assert.deepEqual([...RUNTIME_RPC_OUTPUT_MODES], ["text", "json"]);
	});

	it("correlation v1 without a version still validates exactly as before", () => {
		assert.equal(validateRuntimeRequest({ ...base, requestId: "v1a", method: "start", params: startParams() }).ok, true);
		const explicit = validateRuntimeRequest({
			...base,
			requestId: "v1b",
			method: "start",
			params: startParams({ correlation: { correlationVersion: 1, owner: "northstar", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0 } }),
		});
		assert.equal(explicit.ok, true);
		const extra = validateRuntimeRequest({
			...base,
			requestId: "v1c",
			method: "start",
			params: startParams({ correlation: { owner: "northstar", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0, jobId: "x" } }),
		});
		assert.equal(extra.ok, false);
		if (!extra.ok) assert.equal(extra.code, "invalid_params");
	});

	it("correlation v2 accepts pattern handles and rejects bad owner, bad role, and version 3", () => {
		const good = {
			correlationVersion: 2,
			owner: "acme-team_1",
			correlationId: "corr-9",
			queryIndex: 1,
			role: "field_lead",
			stage: "plan",
			attempt: 0,
		};
		assert.equal(validateRuntimeRequest({ ...base, requestId: "v2a", method: "start", params: startParams({ correlation: good }) }).ok, true);
		assert.ok(RUNTIME_RPC_CORRELATION_V2_OWNER_PATTERN.test("acme-team_1"));
		assert.ok(RUNTIME_RPC_CORRELATION_V2_ROLE_PATTERN.test("field_lead"));
		for (const [id, correlation] of [
			["v2-owner", { ...good, owner: "AB" }],
			["v2-role", { ...good, role: "Bad-Role" }],
			["v2-version", { ...good, correlationVersion: 3 }],
			["v2-extra", { ...good, jobId: "x" }],
		] as const) {
			const result = validateRuntimeRequest({ ...base, requestId: id, method: "start", params: startParams({ correlation }) });
			assert.equal(result.ok, false, id);
			if (!result.ok) assert.equal(result.code, "invalid_params", id);
		}
	});

	it("role registry export matches the v1 role enum for consumers", () => {
		assert.deepEqual([...RUNTIME_RPC_ROLE_REGISTRY], [...RUNTIME_RPC_ROLES]);
	});

	it("jsonSchema dialects advertise flat-v1 and structured-v1", () => {
		assert.deepEqual([...RUNTIME_RPC_JSON_SCHEMA_DIALECTS], ["flat-v1", "structured-v1"]);
		const unknown = validateRuntimeRequest({
			...base,
			requestId: "d1",
			method: "start",
			params: startParams({ outputSchema: JSON_SCHEMA }),
		}, { jsonSchemaDialect: "wide-v3" });
		assert.equal(unknown.ok, false);
		if (!unknown.ok) assert.equal(unknown.code, "invalid_params");
	});

	it("structured dialect validates nested planner/evaluator output; flat rejects the same schema", async () => {
		const nested = {
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
						},
						additionalProperties: false,
					},
				},
				total: { type: "integer", minimum: 0 },
			},
			additionalProperties: false,
		};
		assert.equal(
			validateRuntimeRequest(
				{ ...base, requestId: "sg", method: "start", params: startParams({ outputSchema: nested }) },
				{ jsonSchemaDialect: "structured-v1" },
			).ok,
			true,
		);
		assert.equal(
			validateRuntimeRequest({ ...base, requestId: "fg", method: "start", params: startParams({ outputSchema: nested }) }).ok,
			false,
		);
		const good = JSON.stringify({
			questions: [
				{ query: "q1", priority: 3, route: "web" },
				{ query: "q2", priority: 1, route: "github", extra: "dropped" },
			],
			total: 2,
		});
		const strict = JSON.stringify({ questions: [{ query: "q1", priority: 3, route: "web", lane: "oops" }], total: 1 });
		// additionalProperties:false is closed-world: the extra key fails.
		await assert.rejects(executeLeafRun(fakeHost(strict), jsonParams(strict, nested, "structured-v1")));
		const admitted = JSON.stringify({ questions: [{ query: "q1", priority: 3, route: "web" }], total: 1 });
		const result = await executeLeafRun(fakeHost(admitted), jsonParams(admitted, nested, "structured-v1"));
		assert.deepEqual(result, { output: admitted, outputTokens: 10 });
		assert.deepEqual(JSON.parse(good).questions.length, 2);
		for (const bad of [
			JSON.stringify({ questions: [{ query: "q1", priority: 9, route: "web" }], total: 1 }),
			JSON.stringify({ questions: [{ query: "q1", priority: 2, route: "video" }], total: 1 }),
			JSON.stringify({ questions: "not-an-array", total: 1 }),
			JSON.stringify({ questions: [], total: -1 }),
		]) {
			await assert.rejects(
				executeLeafRun(fakeHost(bad), jsonParams(bad, nested, "structured-v1")),
				(error: unknown) =>
					error instanceof LeafFailure &&
					error.code === "output_contract_breach" &&
					error.message === "Leaf run output failed schema validation.",
			);
		}
		// Same nested schema under the flat dialect fails closed at the session gate.
		await assert.rejects(
			executeLeafRun(fakeHost(admitted), jsonParams(admitted, nested)),
			(error: unknown) =>
				error instanceof LeafFailure &&
				error.code === "output_contract_breach" &&
				error.message === "Leaf run outputSchema is not a supported flat object schema.",
		);
		// Unknown session dialect rejects without touching output.
		await assert.rejects(
			executeLeafRun(fakeHost(admitted), { ...jsonParams(admitted, nested), outputSchemaDialect: "wide-v3" as never }),
			(error: unknown) => error instanceof LeafFailure && error.code === "invalid_params",
		);
	});

	it("hardening: misplaced minimum/maximum/items keys reject at gate and session", async () => {
		const text = JSON.stringify({ summary: "done" });
		for (const schema of [
			{ type: "string", minimum: 1 },
			{ type: "string", maximum: 5 },
			{ type: "object", properties: { a: { type: "string" } }, minimum: 0 },
			{ type: "array", items: { type: "string" }, minimum: 0 },
			{ type: "object", properties: { a: { type: "string" } }, items: { type: "string" } },
			{ type: "string", items: { type: "string" } },
		]) {
			const gated = validateRuntimeRequest(
				{ ...base, requestId: "hard-mis", method: "start", params: startParams({ outputSchema: schema }) },
				{ jsonSchemaDialect: "structured-v1" },
			);
			assert.equal(gated.ok, false);
			if (!gated.ok) assert.equal(gated.code, "invalid_params");
			await assert.rejects(
				executeLeafRun(fakeHost(text), jsonParams(text, schema, "structured-v1")),
				(error: unknown) => error instanceof LeafFailure && error.code === "output_contract_breach",
			);
		}
		// Untyped items/minimum stay admitted (type undefined inherits the constraint).
		const untyped = {
			type: "object",
			required: ["summary"],
			properties: { summary: { type: "string" }, count: { minimum: 0 } },
		};
		assert.equal(
			validateRuntimeRequest(
				{ ...base, requestId: "hard-untyped", method: "start", params: startParams({ outputSchema: untyped }) },
				{ jsonSchemaDialect: "structured-v1" },
			).ok,
			true,
		);
	});

	it("hardening: non-finite minimum/maximum reject at gate and session", async () => {
		const text = JSON.stringify({ summary: "done", count: 1 });
		for (const bound of [Number.POSITIVE_INFINITY, Number.NaN]) {
			const schema = { type: "object", required: ["count"], properties: { count: { type: "integer", minimum: bound } } };
			const gated = validateRuntimeRequest(
				{ ...base, requestId: "hard-fin", method: "start", params: startParams({ outputSchema: schema }) },
				{ jsonSchemaDialect: "structured-v1" },
			);
			assert.equal(gated.ok, false);
			if (!gated.ok) assert.equal(gated.code, "invalid_params");
			await assert.rejects(
				executeLeafRun(fakeHost(text), jsonParams(text, schema, "structured-v1")),
				(error: unknown) => error instanceof LeafFailure && error.code === "output_contract_breach",
			);
		}
	});

	it("hardening: degenerate closed-world object rejects non-empty at validation time", async () => {
		const schema = { type: "object", additionalProperties: false };
		const gated = validateRuntimeRequest(
			{ ...base, requestId: "hard-deg", method: "start", params: startParams({ outputSchema: schema }) },
			{ jsonSchemaDialect: "structured-v1" },
		);
		assert.equal(gated.ok, true);
		const empty = JSON.stringify({});
		assert.deepEqual(await executeLeafRun(fakeHost(empty), jsonParams(empty, schema, "structured-v1")), {
			output: empty,
			outputTokens: 10,
		});
		const nonempty = JSON.stringify({ a: 1 });
		await assert.rejects(
			executeLeafRun(fakeHost(nonempty), jsonParams(nonempty, schema, "structured-v1")),
			(error: unknown) =>
				error instanceof LeafFailure &&
				error.code === "output_contract_breach" &&
				error.message === "Leaf run output failed schema validation.",
		);
	});

	it("hardening: untyped numeric bounds and typeless closed-world enforce at validation time", async () => {
		const breach = (error: unknown) =>
			error instanceof LeafFailure &&
			error.code === "output_contract_breach" &&
			error.message === "Leaf run output failed schema validation.";
		// Untyped {minimum:0} is admitted at the gate but must breach on count:-5.
		const untyped = { type: "object", required: ["count"], properties: { count: { minimum: 0 } } };
		assert.equal(
			validateRuntimeRequest(
				{ ...base, requestId: "hard-untyped-min", method: "start", params: startParams({ outputSchema: untyped }) },
				{ jsonSchemaDialect: "structured-v1" },
			).ok,
			true,
		);
		const negative = JSON.stringify({ count: -5 });
		await assert.rejects(executeLeafRun(fakeHost(negative), jsonParams(negative, untyped, "structured-v1")), breach);
		// Same output under an explicitly typed integer bound breaches (unchanged).
		const typed = { type: "object", required: ["count"], properties: { count: { type: "integer", minimum: 0 } } };
		await assert.rejects(executeLeafRun(fakeHost(negative), jsonParams(negative, typed, "structured-v1")), breach);
		// Typeless {additionalProperties:false} is admitted at the gate but
		// breaches on a primitive string output.
		const typelessClosed = { additionalProperties: false };
		assert.equal(
			validateRuntimeRequest(
				{ ...base, requestId: "hard-typeless-closed", method: "start", params: startParams({ outputSchema: typelessClosed }) },
				{ jsonSchemaDialect: "structured-v1" },
			).ok,
			true,
		);
		const strOut = JSON.stringify("hi");
		await assert.rejects(executeLeafRun(fakeHost(strOut), jsonParams(strOut, typelessClosed, "structured-v1")), breach);
		// Compliant outputs still pass on all three shapes.
		const zero = JSON.stringify({ count: 0 });
		assert.deepEqual(await executeLeafRun(fakeHost(zero), jsonParams(zero, untyped, "structured-v1")), { output: zero, outputTokens: 10 });
		const three = JSON.stringify({ count: 3 });
		assert.deepEqual(await executeLeafRun(fakeHost(three), jsonParams(three, typed, "structured-v1")), { output: three, outputTokens: 10 });
		const empty = JSON.stringify({});
		assert.deepEqual(await executeLeafRun(fakeHost(empty), jsonParams(empty, typelessClosed, "structured-v1")), { output: empty, outputTokens: 10 });
	});

	it("hardening: third-dialect string rejects rather than silently flattening", async () => {
		const text = JSON.stringify({ summary: "done", count: 1 });
		const gated = validateRuntimeRequest(
			{ ...base, requestId: "hard-dialect", method: "start", params: startParams({ outputSchema: JSON_SCHEMA }) },
			{ jsonSchemaDialect: "flat-v2" },
		);
		assert.equal(gated.ok, false);
		if (!gated.ok) assert.equal(gated.code, "invalid_params");
		await assert.rejects(
			executeLeafRun(fakeHost(text), { ...jsonParams(text), outputSchemaDialect: "flat-v2" as never }),
			(error: unknown) => error instanceof LeafFailure && error.code === "invalid_params",
		);
	});

	it("negotiate advertises outputModes and correlationV2; v2 start requires negotiation", async () => {
		const version = "test-contract-ext-verify-1";
		(VERIFIED_RUNTIME_HOST_VERSIONS as string[]).push(version);
		try {
			const host = {
				hostVersion: version,
				listModels: () => [{ provider: "o", id: "m", fullId: "o/m", api: "openai-responses", maxTokens: 100 }],
			} as unknown as LeafHost;
			const runtime = new LeafModelRuntime({
				host,
				cwd: "/repo",
				execute: () => Promise.resolve({ output: JSON.stringify({ summary: "ok" }), outputTokens: 2 }),
			});
			const events = new FakeEvents();
			const bridge = registerRuntimeRpcBridge({ events, runtime, hostVersion: version });
			const v2Correlation = {
				correlationVersion: 2,
				owner: "acme-team",
				correlationId: "c",
				queryIndex: 0,
				role: "field_lead",
				stage: "s",
				attempt: 0,
			};
			const gated = (await request(events, "v2-ungated", "start", {
				modelId: "o/m",
				prompt: "Do work.",
				maxOutputTokens: 64,
				timeoutMs: 5_000,
				correlation: v2Correlation,
			})) as { success: boolean; error: { code: string } };
			assert.equal(gated.success, false);
			assert.equal(gated.error.code, "invalid_params");
			const negotiated = (await request(events, "v2-neg", "negotiate", { modelId: "o/m" })) as {
				success: boolean;
				data: { capabilities: { outputModes: string[]; correlationV2: { ownerPattern: string; roles: string[] }; jsonSchema: string } };
			};
			assert.equal(negotiated.success, true);
			assert.equal(negotiated.data.capabilities.jsonSchema, "structured-v1");
			assert.ok(negotiated.data.capabilities.outputModes.includes("text"));
			assert.ok(negotiated.data.capabilities.outputModes.includes("json"));
			assert.deepEqual(negotiated.data.capabilities.correlationV2, {
				ownerPattern: RUNTIME_RPC_CORRELATION_V2_OWNER_PATTERN.source,
				roles: [...RUNTIME_RPC_ROLES],
			});
			const admitted = (await request(events, "v2-admitted", "start", {
				modelId: "o/m",
				prompt: "Do work.",
				maxOutputTokens: 64,
				timeoutMs: 5_000,
				correlation: v2Correlation,
			})) as { success: boolean; data: { runId: string } };
			assert.equal(admitted.success, true);
			// Per-model dialect binding: nested schemas pass the start gate only
			// for the negotiated modelId.
			const nestedSchema = {
				type: "object",
				required: ["questions"],
				properties: { questions: { type: "array", items: { type: "object", required: ["query"], properties: { query: { type: "string" } } } } },
			};
			const unbound = (await request(events, "v2-flat-gate", "start", {
				modelId: "o/other",
				prompt: "Do work.",
				maxOutputTokens: 64,
				timeoutMs: 5_000,
				outputSchema: nestedSchema,
				correlation: { owner: "northstar", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0 },
			})) as { success: boolean; error: { code: string } };
			assert.equal(unbound.success, false);
			assert.equal(unbound.error.code, "invalid_params");
			const bound = (await request(events, "v2-structured-gate", "start", {
				modelId: "o/m",
				prompt: "Do work.",
				maxOutputTokens: 64,
				timeoutMs: 5_000,
				outputSchema: nestedSchema,
				correlation: v2Correlation,
			})) as { success: boolean; data: { runId: string } };
			assert.equal(bound.success, true);
			await bridge.dispose();
			await runtime.shutdown(5);
		} finally {
			const index = (VERIFIED_RUNTIME_HOST_VERSIONS as string[]).indexOf(version);
			if (index >= 0) (VERIFIED_RUNTIME_HOST_VERSIONS as string[]).splice(index, 1);
		}
	});

	it("e2e: negotiated dialect flows bridge to runtime to session over the real executeLeafRun path", async () => {
		const version = "test-dialect-plumb-1";
		(VERIFIED_RUNTIME_HOST_VERSIONS as string[]).push(version);
		try {
			const nested = {
				type: "object",
				required: ["questions"],
				properties: {
					questions: {
						type: "array",
						items: {
							type: "object",
							required: ["query"],
							properties: { query: { type: "string" } },
						},
					},
				},
			};
			const text = JSON.stringify({ questions: [{ query: "q1" }, { query: "q2" }] });
			const v1Correlation = { owner: "northstar", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0 };
			const hostFor = () =>
				({
					hostVersion: version,
					listModels: () => [{ provider: "o", id: "m", fullId: "o/m", api: "openai-responses", maxTokens: 100 }],
					createLeafSession: async () => ({
						prompt: async () => ({ text, outputTokens: 2, toolCalls: 0, providerInvocations: 1 }),
						abort: async () => {},
						waitForIdle: async () => {},
						dispose: async () => {},
					}),
				}) as unknown as LeafHost;
			// Negotiated bridge, NO execute seam: the real executeLeafRun path runs.
			const runtime = new LeafModelRuntime({ host: hostFor(), cwd: "/repo" });
			const events = new FakeEvents();
			const bridge = registerRuntimeRpcBridge({ events, runtime, hostVersion: version });
			const negotiated = (await request(events, "plumb-neg", "negotiate", { modelId: "o/m" })) as { success: boolean };
			assert.equal(negotiated.success, true);
			const started = (await request(events, "plumb-start", "start", {
				modelId: "o/m",
				prompt: "Do work.",
				maxOutputTokens: 64,
				timeoutMs: 5_000,
				outputSchema: nested,
				correlation: v1Correlation,
			})) as { success: boolean; data: { runId: string } };
			assert.equal(started.success, true);
			// Without dialect plumbing the session would default to flat-v1 and fail
			// the run ("not a supported flat object schema"); success proves the
			// negotiated structured-v1 dialect reached session validation.
			let completed: { state: string; output?: string } | undefined;
			for (let i = 0; i < 100; i += 1) {
				try {
					const result = runtime.result(started.data.runId) as { state: string; output?: string };
					completed = result;
					break;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			}
			assert.equal(completed?.state, "completed");
			assert.equal(completed?.output, text);
			await bridge.dispose();
			await runtime.shutdown(5);
			// Fresh bridge with no negotiation: the same nested schema is rejected
			// at the gate (flat-v1 default), before any session runs.
			const runtime2 = new LeafModelRuntime({ host: hostFor(), cwd: "/repo" });
			const events2 = new FakeEvents();
			const bridge2 = registerRuntimeRpcBridge({ events: events2, runtime: runtime2, hostVersion: version });
			const gated = (await request(events2, "plumb-gate", "start", {
				modelId: "o/m",
				prompt: "Do work.",
				maxOutputTokens: 64,
				timeoutMs: 5_000,
				outputSchema: nested,
				correlation: v1Correlation,
			})) as { success: boolean; error: { code: string } };
			assert.equal(gated.success, false);
			assert.equal(gated.error.code, "invalid_params");
			// The dialect is bridge-internal: a wire-level outputSchemaDialect field
			// is rejected at the gate (closed shape), never forwarded.
			const wireDialect = (await request(events2, "plumb-wire", "start", {
				modelId: "o/m",
				prompt: "Do work.",
				maxOutputTokens: 64,
				timeoutMs: 5_000,
				outputSchema: JSON_SCHEMA,
				outputSchemaDialect: "structured-v1",
				correlation: v1Correlation,
			})) as { success: boolean; error: { code: string } };
			assert.equal(wireDialect.success, false);
			assert.equal(wireDialect.error.code, "invalid_params");
			await bridge2.dispose();
			await runtime2.shutdown(5);
		} finally {
			const index = (VERIFIED_RUNTIME_HOST_VERSIONS as string[]).indexOf(version);
			if (index >= 0) (VERIFIED_RUNTIME_HOST_VERSIONS as string[]).splice(index, 1);
		}
	});

	it("negotiation state is bounded: oldest evicted on overflow, re-negotiation re-admits", async () => {
		const version = "test-neg-bound-1";
		(VERIFIED_RUNTIME_HOST_VERSIONS as string[]).push(version);
		try {
			const cap = RUNTIME_RPC_BOUNDS.maxNegotiatedModels;
			const count = cap + 5;
			const models = Array.from({ length: count }, (_, index) => ({
				provider: "o",
				id: `m${index}`,
				fullId: `o/m${index}`,
				api: "openai-responses",
				maxTokens: 100,
			}));
			const host = {
				hostVersion: version,
				listModels: () => models,
				createLeafSession: async () => {
					throw new Error("unused");
				},
			} as unknown as LeafHost;
			const runtime = new LeafModelRuntime({ host, cwd: "/repo", execute: () => Promise.resolve({ output: "ok", outputTokens: 2 }) });
			const events = new FakeEvents();
			const bridge = registerRuntimeRpcBridge({ events, runtime, hostVersion: version });
			for (let index = 0; index < count; index += 1) {
				const reply = (await request(events, `bneg-${index}`, "negotiate", { modelId: `o/m${index}` })) as { success: boolean };
				assert.equal(reply.success, true, `negotiate o/m${index}`);
			}
			const v2Correlation = {
				correlationVersion: 2,
				owner: "acme-team",
				correlationId: "c",
				queryIndex: 0,
				role: "field_lead",
				stage: "s",
				attempt: 0,
			};
			const startFor = (modelId: string) => ({
				modelId,
				prompt: "Do work.",
				maxOutputTokens: 64,
				timeoutMs: 5_000,
				correlation: v2Correlation,
			});
			// Oldest entries evicted: v2 start for o/m0 fails closed (never negotiated).
			const gated = (await request(events, "bound-gated", "start", startFor("o/m0"))) as {
				success: boolean;
				error: { code: string };
			};
			assert.equal(gated.success, false);
			assert.equal(gated.error.code, "invalid_params");
			// Newest entry still admitted.
			const admitted = (await request(events, "bound-ok", "start", startFor(`o/m${count - 1}`))) as {
				success: boolean;
				data: { runId: string };
			};
			assert.equal(admitted.success, true);
			// Re-negotiation re-admits the evicted model.
			const renegotiated = (await request(events, "bound-reneg", "negotiate", { modelId: "o/m0" })) as { success: boolean };
			assert.equal(renegotiated.success, true);
			const readmitted = (await request(events, "bound-readmit", "start", startFor("o/m0"))) as { success: boolean };
			assert.equal(readmitted.success, true);
			await bridge.dispose();
			await runtime.shutdown(5);
		} finally {
			const index = (VERIFIED_RUNTIME_HOST_VERSIONS as string[]).indexOf(version);
			if (index >= 0) (VERIFIED_RUNTIME_HOST_VERSIONS as string[]).splice(index, 1);
		}
	});

	it("structured enum objects match regardless of key order", async () => {
		const schema = {
			type: "object",
			required: ["point"],
			properties: { point: { type: "object", enum: [{ x: 1, y: 2 }] } },
		};
		const reordered = JSON.stringify({ point: { y: 2, x: 1 } });
		const result = await executeLeafRun(fakeHost(reordered), jsonParams(reordered, schema, "structured-v1"));
		assert.deepEqual(result, { output: reordered, outputTokens: 10 });
		const mismatch = JSON.stringify({ point: { y: 3, x: 1 } });
		await assert.rejects(
			executeLeafRun(fakeHost(mismatch), jsonParams(mismatch, schema, "structured-v1")),
			(error: unknown) =>
				error instanceof LeafFailure &&
				error.code === "output_contract_breach" &&
				error.message === "Leaf run output failed schema validation.",
		);
	});
});
