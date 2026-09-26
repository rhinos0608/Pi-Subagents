import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChildSession, ChildSessionEvent, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { runSingleStepInner } from "../../src/runs/background/subagent-runner.ts";
import type { RunnerSubagentStep } from "../../src/runs/shared/parallel-utils.ts";
import { makeAgent } from "../support/helpers.ts";

const inherited = { role: "assistant", content: [{ type: "text", text: "old" }], timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } as unknown as AgentMessage;
const liveMessage = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", model: "mock/test", usage: { input: 1, output: 1 } } as unknown as AgentMessage;
const persistedMessage = { ...liveMessage, timestamp: 2 } as unknown as AgentMessage;

/**
 * Scripted factory driving the REAL dispatch loops. `createErrors` is shifted
 * once per child creation: entries reject creation (a session that never
 * existed — zero tool/message progress), exhaustion runs the success stub.
 */
function scriptedFactory(createErrors: unknown[] = [], promptError?: unknown): ChildSessionFactory & { creates: () => number } {
	let creates = 0;
	const factory: ChildSessionFactory = {
		async create() {
			creates++;
			const failure = createErrors.shift();
			if (failure !== undefined) throw failure;
			const listeners = new Set<(event: ChildSessionEvent) => void>();
			let terminal: readonly AgentMessage[] = [inherited];
			return {
				subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
				async prompt() {
					for (const listener of listeners) listener({ type: "message_end", message: liveMessage } as ChildSessionEvent);
					terminal = [inherited, persistedMessage];
					if (promptError !== undefined) throw promptError;
				},
				async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
				get messages() { return terminal; },
				get sessionFile() { return undefined; },
				get sessionId() { return "retry-test"; },
				get modelId() { return "mock/test"; },
			} satisfies ChildSession;
		},
		async dispose() {},
	};
	return Object.assign(factory, { creates: () => creates });
}

describe("model retry dispatch loops", () => {
	it("foreground: retries the same candidate twice, then advances and succeeds", async () => {
		const agent = makeAgent("worker", { model: "mock/test", fallbackModels: ["mock/fallback"] });
		const factory = scriptedFactory([new Error("503 Service Unavailable"), new Error("503 Service Unavailable"), new Error("503 Service Unavailable")]);
		const result = await runSync(process.cwd(), [agent], "worker", "retry dispatch", {
			acceptance: false,
			childSessionFactory: factory,
		});
		assert.equal(factory.creates(), 4);
		assert.equal(result.exitCode, 0);
		assert.equal(result.modelAttempts?.length, 4);
		assert.deepEqual(result.attemptedModels, ["mock/test", "mock/test", "mock/test", "mock/fallback"]);
		assert.ok(result.modelAttempts?.slice(0, 3).every((attempt) => attempt.success === false));
		assert.equal(result.modelAttempts?.[3]?.success, true);
	});

	it("foreground: a task-level tool failure is terminal and never advances", async () => {
		const agent = makeAgent("worker", { model: "mock/test", fallbackModels: ["mock/fallback"] });
		const factory = scriptedFactory([], new Error("read failed (exit 1): no such file"));
		const result = await runSync(process.cwd(), [agent], "worker", "failing task", {
			acceptance: false,
			childSessionFactory: factory,
		});
		assert.equal(factory.creates(), 1);
		assert.equal(result.exitCode, 1);
		assert.equal(result.modelAttempts?.length, 1);
		assert.deepEqual(result.attemptedModels, ["mock/test"]);
	});

	it("background: exhausts all candidates with three attempts each", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-model-retry-"));
		const factory = scriptedFactory();
		const step: RunnerSubagentStep = {
			agent: "worker",
			task: "exhaust dispatch",
			cwd: dir,
			modelCandidates: ["mock/a", "mock/b"],
		};
		const failing: ChildSessionFactory = {
			async create(): Promise<ChildSession> { throw new Error("503 Service Unavailable"); },
			async dispose() {},
		};
		const result = await runSingleStepInner(step, {
			previousOutput: "",
			placeholder: "",
			cwd: dir,
			sessionEnabled: false,
			id: "retry-exhaust",
			flatIndex: 0,
			flatStepCount: 1,
			outputFile: join(dir, "out.log"),
			childSessions: failing,
		});
		assert.equal(factory.creates(), 0);
		assert.equal(result.exitCode, 1);
		assert.equal(result.modelAttempts?.length, 6);
		assert.deepEqual(result.attemptedModels, ["mock/a", "mock/a", "mock/a", "mock/b", "mock/b", "mock/b"]);
		assert.match(result.output ?? "", /\[exhausted\]/);
	});

	it("background: advances after three failures, then succeeds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-model-retry-"));
		const factory = scriptedFactory([new Error("503 Service Unavailable"), new Error("503 Service Unavailable"), new Error("503 Service Unavailable")]);
		const step: RunnerSubagentStep = {
			agent: "worker",
			task: "retry dispatch",
			cwd: dir,
			modelCandidates: ["mock/a", "mock/b"],
		};
		const result = await runSingleStepInner(step, {
			previousOutput: "",
			placeholder: "",
			cwd: dir,
			sessionEnabled: false,
			id: "retry-advance",
			flatIndex: 0,
			flatStepCount: 1,
			outputFile: join(dir, "out.log"),
			childSessions: factory,
		});
		assert.equal(factory.creates(), 4);
		assert.equal(result.exitCode, 0);
		assert.equal(result.modelAttempts?.length, 4);
		assert.deepEqual(result.attemptedModels, ["mock/a", "mock/a", "mock/a", "mock/b"]);
		assert.equal(result.modelAttempts?.[3]?.success, true);
	});
});
