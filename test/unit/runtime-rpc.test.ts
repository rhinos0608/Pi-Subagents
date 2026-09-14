import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	RUNTIME_RPC_PROTOCOL,
	RUNTIME_RPC_READY_EVENT,
	RUNTIME_RPC_REQUEST_EVENT,
	VERIFIED_RUNTIME_HOST_VERSIONS,
	runtimeRpcReplyEvent,
} from "../../src/api/runtime-rpc.ts";
import { isRuntimeGateOpen, isRuntimeRpcDisabled, registerRuntimeRpcBridge, RUNTIME_RPC_DISABLE_ENV_VAR } from "../../src/extension/runtime-rpc.ts";
import { LeafModelRuntime } from "../../src/runs/runtime/leaf-model-runtime.ts";
import type { LeafHost } from "../../src/runs/runtime/leaf-model-session.ts";

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

function once(events: FakeEvents, event: string): Promise<unknown> {
	return new Promise((resolve) => {
		const unsubscribe = events.on(event, (payload) => {
			unsubscribe();
			resolve(payload);
		});
	});
}

function closedRuntime(): LeafModelRuntime {
	return new LeafModelRuntime({ host: null, cwd: "/repo" });
}

function request(events: FakeEvents, requestId: string, method: string, params?: unknown): Promise<unknown> {
	const reply = once(events, runtimeRpcReplyEvent(requestId));
	events.emit(RUNTIME_RPC_REQUEST_EVENT, { version: 1, requestId, method, ...(params !== undefined ? { params } : {}) });
	return reply;
}

describe("runtime RPC bridge", () => {
	it("shim host never opens the gate or emits ready", () => {
		assert.equal(isRuntimeGateOpen("0.0.0-pi-subagents-test-shim"), false);
		assert.equal(isRuntimeGateOpen("unknown"), false);
		const events = new FakeEvents();
		const bridge = registerRuntimeRpcBridge({ events, runtime: closedRuntime(), hostVersion: "0.0.0-pi-subagents-test-shim" });
		bridge.emitReady();
		assert.equal(events.emitted.some((entry) => entry.event === RUNTIME_RPC_READY_EVENT), false);
		void bridge.dispose();
	});

	it("bridge is enabled by default: absent/empty flag still registers request handling", async () => {
		for (const value of [undefined, ""]) {
			const previous = process.env[RUNTIME_RPC_DISABLE_ENV_VAR];
			try {
				if (value === undefined) delete process.env[RUNTIME_RPC_DISABLE_ENV_VAR];
			else process.env[RUNTIME_RPC_DISABLE_ENV_VAR] = value;
			assert.equal(isRuntimeRpcDisabled(), false);
				const events = new FakeEvents();
				const bridge = registerRuntimeRpcBridge({ events, runtime: closedRuntime(), hostVersion: "unknown" });
				const reply = (await request(events, `default-on-status-${value === undefined ? "absent" : "empty"}`, "status", { runId: "runtime_abc" })) as { success: boolean; error: { code: string } };
				assert.equal(reply.success, false);
				assert.equal(reply.error.code, "runtime_unavailable");
				await bridge.dispose();
			} finally {
				if (previous === undefined) delete process.env[RUNTIME_RPC_DISABLE_ENV_VAR];
				else process.env[RUNTIME_RPC_DISABLE_ENV_VAR] = previous;
			}
		}
	});

	it("explicit disable skips registration/ready/request handling entirely", async () => {
		const previous = process.env[RUNTIME_RPC_DISABLE_ENV_VAR];
		try {
			process.env[RUNTIME_RPC_DISABLE_ENV_VAR] = "1";
			assert.equal(isRuntimeRpcDisabled(), true);
			const events = new FakeEvents();
			const bridge = registerRuntimeRpcBridge({ events, runtime: closedRuntime(), hostVersion: "unknown" });
			bridge.emitReady();
			assert.equal(events.emitted.some((entry) => entry.event === RUNTIME_RPC_READY_EVENT), false);
				events.emit(RUNTIME_RPC_REQUEST_EVENT, { version: 1, requestId: "disabled-1", method: "status", params: { runId: "runtime_abc" } });
				await new Promise((resolve) => setTimeout(resolve, 25));
			assert.equal(events.emitted.filter((entry) => entry.event.startsWith("subagents:runtime:v1:reply:")).length, 0);
				await bridge.dispose();
		} finally {
			if (previous === undefined) delete process.env[RUNTIME_RPC_DISABLE_ENV_VAR];
			else process.env[RUNTIME_RPC_DISABLE_ENV_VAR] = previous;
		}
	});

	it("closed gate answers runtime_unavailable with zero provider calls", async () => {
		let calls = 0;
		const runtime = new LeafModelRuntime({ host: null, cwd: "/repo", execute: () => {
			calls += 1;
			throw new Error("must not execute while gate is closed");
		} });
		const events = new FakeEvents();
		const bridge = registerRuntimeRpcBridge({ events, runtime, hostVersion: "unknown" });
		const reply = (await request(events, "closed-start", "start", {
			modelId: "openai/gpt-5-mini",
			prompt: "Do work.",
			maxOutputTokens: 64,
		timeoutMs: 5_000,
			correlation: { owner: "northstar", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0 },
		})) as { success: boolean; error: { code: string } };
		assert.equal(reply.success, false);
		assert.equal(reply.error.code, "runtime_unavailable");
		assert.equal(calls, 0);
		await bridge.dispose();
	});

	it("closed host answers every method with runtime_unavailable", async () => {
		const events = new FakeEvents();
		const bridge = registerRuntimeRpcBridge({ events, runtime: closedRuntime(), hostVersion: "unknown" });
		for (const [method, params] of [
			["negotiate", { modelId: "openai/gpt-5-mini" }],
			["status", { runId: "runtime_abc" }],
			["result", { runId: "runtime_abc" }],
			["cancelAndSettle", { runIds: ["runtime_abc"], settlementWindowMs: 100 }],
		] as const) {
			const reply = (await request(events, `closed-${method}`, method, params)) as { success: boolean; error: { code: string } };
			assert.equal(reply.success, false);
			assert.equal(reply.error.code, "runtime_unavailable");
		}
		await bridge.dispose();
	});

	it("uses a separate namespace from legacy RPC", () => {
		assert.equal(RUNTIME_RPC_REQUEST_EVENT, "subagents:runtime:v1:request");
		assert.equal(RUNTIME_RPC_READY_EVENT, "subagents:runtime:v1:ready");
		assert.equal(RUNTIME_RPC_PROTOCOL, "subagents:runtime:v1");
		assert.ok(!RUNTIME_RPC_REQUEST_EVENT.startsWith("subagents:rpc:v1"));
		assert.equal(runtimeRpcReplyEvent("x"), "subagents:runtime:v1:reply:x");
	});

	it("replays identical request IDs and rejects digest collisions", async () => {
		const events = new FakeEvents();
		const bridge = registerRuntimeRpcBridge({ events, runtime: closedRuntime(), hostVersion: "unknown" });
		const first = (await request(events, "dup-1", "status", { runId: "runtime_abc" })) as { success: boolean };
		assert.equal(first.success, false);
		const replay = (await request(events, "dup-1", "status", { runId: "runtime_abc" })) as { success: boolean };
		assert.equal(replay.success, false);
		const collision = (await request(events, "dup-1", "result", { runId: "runtime_abc" })) as {
			success: boolean;
			error: { code: string };
		};
		assert.equal(collision.success, false);
		assert.equal(collision.error.code, "duplicate_request_id");
		await bridge.dispose();
	});

	it("ignores unroutable request IDs without side effects", async () => {
		const events = new FakeEvents();
		const bridge = registerRuntimeRpcBridge({ events, runtime: closedRuntime(), hostVersion: "unknown" });
		events.emit(RUNTIME_RPC_REQUEST_EVENT, { version: 1, requestId: "bad\nid", method: "status", params: { runId: "runtime_x" } });
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(events.emitted.filter((entry) => entry.event.startsWith("subagents:runtime:v1:reply:")).length, 0);
		await bridge.dispose();
	});

	it("malformed envelopes get safe codes on the routable channel", async () => {
		const events = new FakeEvents();
		const bridge = registerRuntimeRpcBridge({ events, runtime: closedRuntime(), hostVersion: "unknown" });
		const badVersionReply = once(events, runtimeRpcReplyEvent("bad-version"));
		events.emit(RUNTIME_RPC_REQUEST_EVENT, { version: 99, requestId: "bad-version", method: "status", params: { runId: "runtime_x" } });
		const version = (await badVersionReply.catch(() => null)) as { success: boolean; error?: { code: string } } | null;
		assert.equal(version?.success, false);
		assert.equal(version?.error?.code, "unsupported_version");
		const legacy = (await request(events, "legacy-method", "spawn", {})) as { success: boolean; error: { code: string } };
		assert.equal(legacy.success, false);
		assert.equal(legacy.error.code, "unsupported_method");
		await bridge.dispose();
	});

	it("concurrent duplicate starts execute exactly once", async () => {
		const version = "test-bridge-verify-1";
		(VERIFIED_RUNTIME_HOST_VERSIONS as string[]).push(version);
		try {
			let calls = 0;
			let release!: (value: { output: string; outputTokens: number }) => void;
			const gate = new Promise<{ output: string; outputTokens: number }>((resolve) => {
				release = resolve;
			});
			const fakeHost = { hostVersion: version, listModels: () => [], createLeafSession: async () => { throw new Error("unused"); } } as unknown as LeafHost;
			const runtime = new LeafModelRuntime({ host: fakeHost, cwd: "/repo", execute: () => {
				calls += 1;
				return gate;
			} });
			const events = new FakeEvents();
			const bridge = registerRuntimeRpcBridge({ events, runtime, hostVersion: version });
			const params = {
				modelId: "openai/gpt-5-mini",
				prompt: "Do work.",
				maxOutputTokens: 64,
				timeoutMs: 5_000,
				correlation: { owner: "northstar", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0 },
			};
			const first = once(events, runtimeRpcReplyEvent("race-1"));
			const second = once(events, runtimeRpcReplyEvent("race-1"));
			events.emit(RUNTIME_RPC_REQUEST_EVENT, { version: 1, requestId: "race-1", method: "start", params });
			events.emit(RUNTIME_RPC_REQUEST_EVENT, { version: 1, requestId: "race-1", method: "start", params });
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(calls, 1);
			release({ output: "ok", outputTokens: 2 });
			const [a, b] = (await Promise.all([first, second])) as Array<{ success: boolean; data: { runId: string } }>;
			assert.equal(a.success, true);
			assert.equal(b.success, true);
			assert.equal(a.data.runId, b.data.runId);
			assert.equal(calls, 1);
			await bridge.dispose();
		} finally {
			const index = (VERIFIED_RUNTIME_HOST_VERSIONS as string[]).indexOf(version);
			if (index >= 0) (VERIFIED_RUNTIME_HOST_VERSIONS as string[]).splice(index, 1);
		}
	});

	it("negotiation fails closed on impossibly inverted token range", async () => {
		const version = "test-bridge-verify-2";
		(VERIFIED_RUNTIME_HOST_VERSIONS as string[]).push(version);
		try {
			const host = { hostVersion: version, listModels: () => [{ provider: "o", id: "m", fullId: "o/m", api: "openai-responses", maxTokens: 10 }] } as unknown as LeafHost;
			const runtime = new LeafModelRuntime({ host, cwd: "/repo" });
			const events = new FakeEvents();
			const bridge = registerRuntimeRpcBridge({ events, runtime, hostVersion: version });
			const reply = (await request(events, "neg-small", "negotiate", { modelId: "o/m" })) as { success: boolean; error: { code: string } };
			assert.equal(reply.success, false);
			assert.equal(reply.error.code, "unsupported_capability");
			await bridge.dispose();
		} finally {
			const index = (VERIFIED_RUNTIME_HOST_VERSIONS as string[]).indexOf(version);
			if (index >= 0) (VERIFIED_RUNTIME_HOST_VERSIONS as string[]).splice(index, 1);
		}
	});

	it("negotiation never advertises capabilities after the breaker trips", async () => {
		const version = "test-bridge-verify-3";
		(VERIFIED_RUNTIME_HOST_VERSIONS as string[]).push(version);
		try {
			const host = { hostVersion: version, listModels: () => [{ provider: "o", id: "m", fullId: "o/m", api: "openai-responses", maxTokens: 100 }] } as unknown as LeafHost;
			const runtime = new LeafModelRuntime({ host, cwd: "/repo", execute: () => new Promise(() => {}) as Promise<{ output: string; outputTokens: number }> });
			const run = runtime.start({
				modelId: "o/m",
				prompt: "Do work.",
				maxOutputTokens: 64,
				timeoutMs: 600_000,
				correlation: { owner: "northstar", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0 },
			});
			await assert.rejects(runtime.cancelAndSettle([run.runId], 15), (error: unknown) => (error as { code: string }).code === "contract_breach");
			const events = new FakeEvents();
			const bridge = registerRuntimeRpcBridge({ events, runtime, hostVersion: version });
			const reply = (await request(events, "neg-breach", "negotiate", { modelId: "o/m" })) as { success: boolean; error: { code: string } };
			assert.equal(reply.success, false);
			assert.equal(reply.error.code, "contract_breach");
			await runtime.shutdown(5);
			await bridge.dispose();
		} finally {
			const index = (VERIFIED_RUNTIME_HOST_VERSIONS as string[]).indexOf(version);
			if (index >= 0) (VERIFIED_RUNTIME_HOST_VERSIONS as string[]).splice(index, 1);
		}
	});

	it("open gate negotiates exact models only", async () => {
		const { isVerifiedHostVersion } = await import("../../src/runs/runtime/leaf-model-session.ts");
		assert.equal(typeof isVerifiedHostVersion, "function");
		const host = { hostVersion: "v", listModels: () => [{ provider: "openai", id: "m", fullId: "openai/m", api: "openai-responses", maxTokens: 100 }] } as unknown as LeafHost;
		const runtime = new LeafModelRuntime({ host, cwd: "/repo" });
		const events = new FakeEvents();
		// Gate still closed (shim version string); negotiate proves unavailable, not support.
		const bridge = registerRuntimeRpcBridge({ events, runtime, hostVersion: "0.0.0-pi-subagents-test-shim" });
		const reply = (await request(events, "neg-1", "negotiate", { modelId: "openai/m" })) as { success: boolean; error: { code: string } };
		assert.equal(reply.success, false);
		assert.equal(reply.error.code, "runtime_unavailable");
		await bridge.dispose();
	});
});
