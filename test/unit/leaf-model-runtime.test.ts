import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RUNTIME_RPC_BOUNDS, VERIFIED_RUNTIME_HOST_VERSIONS } from "../../src/api/runtime-rpc.ts";
import { LeafModelRuntime, RuntimeError } from "../../src/runs/runtime/leaf-model-runtime.ts";
import type { LeafHost } from "../../src/runs/runtime/leaf-model-session.ts";

// Defense-in-depth (requireAvailable) rejects unverified hosts, so fixtures use
// a genuinely allowlisted version; the unverified-host case has its own test.
const VERIFIED_HOST_VERSION = VERIFIED_RUNTIME_HOST_VERSIONS[0] as string;

const FAKE_MODELS = [{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", api: "openai-responses", maxTokens: 8192 }];
const HOST = { hostVersion: VERIFIED_HOST_VERSION, listModels: () => FAKE_MODELS, createLeafSession: async () => { throw new Error("unused"); } } as unknown as LeafHost;

function startParams(overrides: Record<string, unknown> = {}) {
	return {
		modelId: "openai/gpt-5-mini",
		prompt: "Do work.",
		maxOutputTokens: 64,
		timeoutMs: 5_000,
		correlation: { owner: "northstar", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0 },
		...overrides,
	} as Parameters<LeafModelRuntime["start"]>[0];
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("leaf runtime manager", () => {
	it("reserves slots synchronously; fifth run rejected at limit four", async () => {
		const gates = Array.from({ length: 5 }, () => deferred<{ output: string; outputTokens: number }>());
		let calls = 0;
		const runtime = new LeafModelRuntime({
			host: HOST,
			cwd: "/repo",
			execute: () => {
				const gate = gates[calls++];
				return gate.promise;
			},
		});
		const runs = [runtime.start(startParams()), runtime.start(startParams()), runtime.start(startParams()), runtime.start(startParams())];
		assert.equal(runtime.activeRuns, 4);
		assert.throws(() => runtime.start(startParams()), (error: unknown) => error instanceof RuntimeError && error.code === "capacity_exceeded");
		for (const [index, run] of runs.entries()) {
			gates[index].resolve({ output: `o${index}`, outputTokens: 5 });
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(runtime.activeRuns, 0);
		for (const run of runs) assert.equal(runtime.result(run.runId).state, "completed");
	});

	it("rejects text-only violation: outputSchema unsupported", () => {
		const runtime = new LeafModelRuntime({ host: HOST, cwd: "/repo" });
		assert.throws(() => runtime.start(startParams({ outputSchema: { type: "object" } })), (error: unknown) => error instanceof RuntimeError && error.code === "unsupported_capability");
	});

	it("fails closed without host", () => {
		const runtime = new LeafModelRuntime({ host: null, cwd: "/repo" });
		assert.throws(() => runtime.start(startParams()), (error: unknown) => error instanceof RuntimeError && error.code === "runtime_unavailable");
	});

	it("result on running is invalid_state; unknown runs are not_found", () => {
		const gate = deferred<{ output: string; outputTokens: number }>();
		const runtime = new LeafModelRuntime({ host: HOST, cwd: "/repo", execute: () => gate.promise });
		const run = runtime.start(startParams());
		assert.throws(() => runtime.result(run.runId), (error: unknown) => error instanceof RuntimeError && error.code === "invalid_state");
		assert.throws(() => runtime.status("runtime_missing"), (error: unknown) => error instanceof RuntimeError && error.code === "not_found");
		gate.resolve({ output: "done", outputTokens: 3 });
	});

	it("byte-limit violations fail before publication", async () => {
		const runtime = new LeafModelRuntime({
			host: HOST,
			cwd: "/repo",
			execute: async () => ({ output: "x".repeat(RUNTIME_RPC_BOUNDS.maxResultBytes + 1), outputTokens: 5 }),
		});
		const run = runtime.start(startParams());
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.throws(() => runtime.result(run.runId), (error: unknown) => error instanceof RuntimeError && error.code === "result_byte_limit_exceeded");
		assert.equal(runtime.status(run.runId).state, "failed");
	});

	it("cancelAndSettle accounts every run; terminal runs included", async () => {
		const gate = deferred<{ output: string; outputTokens: number; toolCalls: number; providerInvocations: number }>();
		let aborted = 0;
		const runtime = new LeafModelRuntime({
			host: {
				hostVersion: VERIFIED_HOST_VERSION,
				listModels: () => FAKE_MODELS,
				createLeafSession: async () => ({
					prompt: () => gate.promise,
					abort: async () => {
						aborted += 1;
					},
					waitForIdle: async () => {},
					dispose: async () => {},
				}),
			} as unknown as LeafHost,
			cwd: "/repo",
		});
		const running = runtime.start(startParams());
		const done = new LeafModelRuntime({ host: HOST, cwd: "/repo", execute: async () => ({ output: "ok", outputTokens: 2 }) });
		const finished = done.start(startParams());
		await new Promise((resolve) => setTimeout(resolve, 25));
		// Settle while the run is still live: abort must fire before completion.
		const settling = runtime.cancelAndSettle([running.runId], 5_000);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.ok(aborted >= 1);
		gate.resolve({ output: "late", text: "late", outputTokens: 2, toolCalls: 0, providerInvocations: 1 });
		const settled = await settling;
		assert.deepEqual(settled.settlements.map((entry) => entry.state), ["completed"]);
		const settledDone = await done.cancelAndSettle([finished.runId], 5_000);
		assert.deepEqual(settledDone.settlements, [{ runId: finished.runId, state: "completed" }]);
	});

	it("unknown IDs cause zero partial cancellation", async () => {
		const gate = deferred<{ output: string; outputTokens: number }>();
		const runtime = new LeafModelRuntime({ host: HOST, cwd: "/repo", execute: () => gate.promise });
		const run = runtime.start(startParams());
		await assert.rejects(runtime.cancelAndSettle([run.runId, "runtime_missing"], 1000), (error: unknown) => error instanceof RuntimeError && error.code === "not_found");
		assert.equal(runtime.status(run.runId).state, "running");
		gate.resolve({ output: "ok", outputTokens: 1 });
	});

	it("hung abort produces bounded contract_breach and trips the breaker", async () => {
		const runtime = new LeafModelRuntime({
			host: {
				hostVersion: VERIFIED_HOST_VERSION,
				listModels: () => FAKE_MODELS,
				createLeafSession: async () => ({
					prompt: () => new Promise(() => {}),
					abort: async () => {},
					waitForIdle: async () => {},
					dispose: async () => {},
				}),
			} as unknown as LeafHost,
			cwd: "/repo",
			now: () => Date.now(),
		});
		const run = runtime.start({ ...startParams(), timeoutMs: 600_000 });
		await assert.rejects(runtime.cancelAndSettle([run.runId], 15), (error: unknown) => error instanceof RuntimeError && error.code === "contract_breach");
		assert.equal(runtime.isUnhealthy, true);
		assert.throws(() => runtime.start(startParams()), (error: unknown) => error instanceof RuntimeError && error.code === "contract_breach");
		// Existing runs stay readable after breach.
		assert.equal(runtime.status(run.runId).state, "running");
		await runtime.shutdown(5);
	});

	it("timeout settles cancelled once abort settles provider work", async () => {
		let rejectPrompt!: (error: unknown) => void;
		let timeoutAborted = 0;
		const timeoutRuntime = new LeafModelRuntime({
			host: {
				hostVersion: VERIFIED_HOST_VERSION,
				listModels: () => FAKE_MODELS,
				createLeafSession: async () => ({
					prompt: () => new Promise<never>((_, reject) => {
						rejectPrompt = reject;
					}),
					abort: async () => {
						timeoutAborted += 1;
						rejectPrompt(new Error("aborted"));
					},
					waitForIdle: async () => {},
					dispose: async () => {},
				}),
			} as unknown as LeafHost,
			cwd: "/repo",
		});
		const timeoutRun = timeoutRuntime.start({ ...startParams(), timeoutMs: 15 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(timeoutRuntime.status(timeoutRun.runId).state, "cancelled");
		assert.ok(timeoutAborted >= 1);
		assert.equal(timeoutRuntime.activeRuns, 0);
		await timeoutRuntime.shutdown(5);
	});

	it("timeout with hung provider forfeits the slot after a bounded grace", async () => {
		const runtime = new LeafModelRuntime({
			host: {
				hostVersion: VERIFIED_HOST_VERSION,
				listModels: () => FAKE_MODELS,
				createLeafSession: async () => ({
					prompt: () => new Promise(() => {}),
					abort: async () => {},
					waitForIdle: async () => {},
					dispose: async () => {},
				}),
			} as unknown as LeafHost,
			cwd: "/repo",
		});
		const run = runtime.start({ ...startParams(), timeoutMs: 15 });
		const settled = (runtime as unknown as { runs: Map<string, { settled: Promise<void> }> }).runs.get(run.runId)!.settled;
		let settledResolved = false;
		void settled.then(() => { settledResolved = true; });
		// Hung orphan: run force-finishes cancelled, slot freed, breaker untripped.
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(runtime.status(run.runId).state, "cancelled");
		assert.equal(settledResolved, true);
		assert.equal(runtime.activeRuns, 0);
		assert.equal(runtime.isUnhealthy, false);
		// Slots reusable: fill to capacity, 5th start still capacity_exceeded.
		const gates: Array<(value: { output: string; outputTokens: number }) => void> = [];
		const gatedHost = {
			hostVersion: VERIFIED_HOST_VERSION,
			listModels: () => FAKE_MODELS,
			createLeafSession: async () => ({
				prompt: () => new Promise<{ output: string; outputTokens: number }>((resolve) => { gates.push(resolve); }),
				abort: async () => {},
				waitForIdle: async () => {},
				dispose: async () => {},
			}),
		} as unknown as LeafHost;
		runtime.setHost(gatedHost);
		for (let i = 0; i < RUNTIME_RPC_BOUNDS.maxParallelRuns; i += 1) runtime.start(startParams());
		assert.equal(runtime.activeRuns, RUNTIME_RPC_BOUNDS.maxParallelRuns);
		assert.throws(() => runtime.start(startParams()), (error: unknown) => error instanceof RuntimeError && error.code === "capacity_exceeded");
		for (const release of gates) release({ output: "ok", outputTokens: 2 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		await runtime.shutdown(5);
	});

	it("shutdown with hung abort resolves bounded and force-finishes cancelled", async () => {
		const runtime = new LeafModelRuntime({
			host: {
				hostVersion: VERIFIED_HOST_VERSION,
				listModels: () => FAKE_MODELS,
				createLeafSession: async () => ({
					prompt: () => new Promise(() => {}),
					abort: () => new Promise<void>(() => {}),
					waitForIdle: async () => {},
					dispose: async () => {},
				}),
			} as unknown as LeafHost,
			cwd: "/repo",
		});
		const run = runtime.start({ ...startParams(), timeoutMs: 600_000 });
		const settled = (runtime as unknown as { runs: Map<string, { settled: Promise<void> }> }).runs.get(run.runId)!.settled;
		let settledResolved = false;
		void settled.then(() => { settledResolved = true; });
		const startedAt = Date.now();
		await runtime.shutdown(20);
		const elapsed = Date.now() - startedAt;
		assert.ok(elapsed < 2_000, `shutdown stuck: ${elapsed}ms`);
		assert.equal(settledResolved, true);
		// shutdown nulls the host, so status() fails closed; assert terminal state via the record.
		const records = (runtime as unknown as { runs: Map<string, { state: string }> }).runs;
		assert.equal(records.get(run.runId)!.state, "cancelled");
		assert.equal(runtime.activeRuns, 0);
		assert.equal(runtime.isUnhealthy, false);
		// Dead runtime fails closed: no re-arm, no new starts.
		assert.throws(() => runtime.start(startParams()), (error: unknown) => error instanceof RuntimeError && error.code === "runtime_unavailable");
	});

	it("setHost after shutdown cannot re-arm the runtime", async () => {
		const runtime = new LeafModelRuntime({ host: HOST, cwd: "/repo" });
		await runtime.shutdown(5);
		runtime.setHost(HOST);
		assert.throws(() => runtime.start(startParams()), (error: unknown) => error instanceof RuntimeError && error.code === "runtime_unavailable");
	});

	it("directly-constructed runtime with an unverified host fails closed", () => {
		const runtime = new LeafModelRuntime({
			host: { hostVersion: "evil-unverified", listModels: () => FAKE_MODELS } as unknown as LeafHost,
			cwd: "/repo",
		});
		assert.throws(() => runtime.start(startParams()), (error: unknown) => error instanceof RuntimeError && error.code === "runtime_unavailable");
		const gated = new LeafModelRuntime({ host: HOST, cwd: "/repo" });
		gated.setHost({ hostVersion: "0.0.0-pi-subagents-test-shim", listModels: () => FAKE_MODELS } as unknown as LeafHost);
		assert.throws(() => gated.start(startParams()), (error: unknown) => error instanceof RuntimeError && error.code === "runtime_unavailable");
	});
});
