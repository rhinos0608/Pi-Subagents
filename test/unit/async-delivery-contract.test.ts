/**
 * Async-delivery contract (Phase 1a).
 *
 * Single place stating the target async-delivery contract as currently-true
 * behavior. Each assertion below delegates to the same production seams the
 * dedicated suites already exercise (notify, completion-dedupe,
 * wait-subscriptions, nested-events); this file links those mechanisms to the
 * contract without duplicating their deep coverage.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import registerSubagentNotify, {
	createCompletionSendRegistry,
} from "../../src/runs/background/notify.ts";
import { buildCompletionKey, markSeenWithTtl } from "../../src/runs/background/completion-dedupe.ts";
import { waitForSubagents } from "../../src/runs/background/subagent-wait.ts";
import { createWaitSubscriptionManager } from "../../src/runs/background/wait-subscriptions.ts";
import {
	createNestedRoute,
	projectNestedEvents,
	writeNestedEvent,
} from "../../src/runs/shared/nested-events.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentState } from "../../src/shared/types.ts";
import { writeAsyncStatusFixture as writeStatus } from "../support/async-status-fixture.ts";

const COMPLETION_OWNER_ID = "contract-owner-a";

function createEventBus() {
	const emitter = new EventEmitter();
	return {
		on(event: string, listener: (...args: unknown[]) => void) {
			emitter.on(event, listener);
			return () => emitter.off(event, listener);
		},
		emit(event: string, ...args: unknown[]) {
			return emitter.emit(event, ...args);
		},
	};
}

function createContractPi(currentSessionId = "session-a") {
	const events = createEventBus();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};
	const notifier = registerSubagentNotify(pi as never, { currentSessionId, completionOwnerId: COMPLETION_OWNER_ID }, {
		batchConfig: { enabled: false },
		sendRegistry: createCompletionSendRegistry(),
	});
	return { events, sent, notifier, dispose: () => notifier.dispose() };
}

function completionResult(overrides: Record<string, unknown> = {}) {
	return {
		id: "contract-run",
		agent: "worker",
		success: true,
		summary: "Done",
		exitCode: 0,
		timestamp: 123,
		sessionId: "session-a",
		completionOwnerId: COMPLETION_OWNER_ID,
		...overrides,
	};
}

function makeWaitState(sessionId = "session-a"): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as SubagentState;
}

const nestedRoutes: Array<{ eventSink: string }> = [];
afterEach(async () => {
	for (const route of nestedRoutes.splice(0)) {
		fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
	}
});

describe("async delivery contract", () => {
	it("launch/wait returns immediately instead of blocking on child completion", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-contract-launch-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeStatus(asyncRoot, "run-alpha", "running", { sessionId: "session-a", pid: 999_999 });
			let slept = false;
			const result = await waitForSubagents({ id: "run-alph", nonBlocking: true, timeoutMs: 5_000 }, undefined, {
				state: makeWaitState(),
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				sleep: async () => { slept = true; throw new Error("launch must not block"); },
				subscribe: (input) => {
					assert.equal(input.runId, "run-alpha");
					return { token: "wait-token", expiresAt: 6_000 };
				},
			});
			assert.equal(result.isError, undefined);
			assert.equal(slept, false);
			assert.match(String((result.content[0] as { text?: string }).text ?? ""), /Armed wait subscription wait-token/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("parent receives completion automatically via the native notification path", () => {
		const { events, sent, dispose } = createContractPi();
		try {
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "contract-auto-1" }));
			assert.equal(sent.length, 1);
			assert.deepEqual(sent[0]?.options, { triggerTurn: true });
		} finally {
			dispose();
		}
	});

	it("no polling is required to observe completion", () => {
		const { events, sent, dispose } = createContractPi();
		try {
			// Delivery happens synchronously on emit: no reconcile/scan/timer
			// advance is needed before the parent can observe the completion.
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "contract-nopoll-1" }));
			assert.equal(sent.length, 1);
		} finally {
			dispose();
		}
	});

	it("failure wakes the parent", () => {
		const { events, sent, dispose } = createContractPi();
		try {
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({
				id: "contract-fail-1",
				success: false,
				summary: "boom",
				exitCode: 1,
			}));
			assert.equal(sent.length, 1);
			assert.deepEqual(sent[0]?.options, { triggerTurn: true });
			assert.match(String((sent[0]?.message as { content: string }).content), /Background task failed/);
		} finally {
			dispose();
		}
	});

	it("attention (paused) states wake the parent", async () => {
		const { events, sent, dispose } = createContractPi();
		try {
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({
				id: "contract-paused-1",
				success: false,
				state: "paused",
				summary: "Paused after interrupt. Waiting for explicit next action.",
			}));
			assert.equal(sent.length, 1);
			assert.deepEqual(sent[0]?.options, { triggerTurn: true });
			assert.match(String((sent[0]?.message as { content: string }).content), /paused/);
		} finally {
			dispose();
		}

		// Wait-subscription path: a run entering needs_attention wakes the waiter.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-contract-attention-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const subscriptionsDir = path.join(root, "subscriptions");
			const delivered: string[] = [];
			const manager = createWaitSubscriptionManager({
				events: createEventBus() as never,
				sendMessage(message: { content?: unknown }) { delivered.push(String(message.content)); },
			} as never, makeWaitState(), { asyncDirRoot: asyncRoot, subscriptionsDir, pollIntervalMs: 60_000, kill: () => true });
			try {
				writeStatus(asyncRoot, "run-attention", "running", { sessionId: "session-a", pid: 999_999 });
				manager.arm({ targetKind: "async", runId: "run-attention", requestedId: "run-attention", timeoutMs: 5_000 });
				writeStatus(asyncRoot, "run-attention", "running", {
					sessionId: "session-a",
					pid: 999_999,
					activityState: "needs_attention",
					steps: [{ agent: "worker", status: "running", activityState: "needs_attention" }],
				});
				manager.reconcile();
				assert.match(delivered[0] ?? "", /needs attention/);
			} finally {
				manager.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("nested delegation routes completion to the owning parent, not a sibling", () => {
		const owner = createNestedRoute("owner-root");
		const sibling = createNestedRoute("sibling-root");
		nestedRoutes.push(owner, sibling);
		writeNestedEvent(owner, {
			type: "subagent.nested.completed",
			ts: 300,
			parentRunId: "owner-root",
			parentStepIndex: 1,
			child: {
				id: "nested-child",
				parentRunId: "owner-root",
				parentStepIndex: 1,
				depth: 1,
				path: [{ runId: "owner-root", stepIndex: 1 }],
				mode: "single",
				state: "complete",
				agent: "reviewer",
				agents: ["reviewer"],
				startedAt: 10,
				lastUpdate: 300,
				steps: [{ agent: "leaf", status: "complete" }],
			},
		});
		const ownerRegistry = projectNestedEvents(owner);
		const siblingRegistry = projectNestedEvents(sibling);
		assert.equal(ownerRegistry.children[0]?.id, "nested-child");
		assert.equal(siblingRegistry.children.some((child) => child.id === "nested-child"), false);

		// Ownership seam: the notifier rejects completions owned by another parent.
		const { events, sent, dispose } = createContractPi("session-owner");
		try {
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({
				id: "contract-foreign-1",
				sessionId: "session-other",
			}));
			assert.deepEqual(sent, []);
		} finally {
			dispose();
		}
	});

	it("duplicate completion is not delivered twice", async () => {
		const { notifier, sent, dispose } = createContractPi();
		try {
			const result = completionResult({ id: "contract-dupe-1" });
			assert.equal(await notifier.deliver(result), true);
			assert.equal(await notifier.deliver(result), true);
			assert.equal(sent.length, 1);
		} finally {
			dispose();
		}

		// Key-level seam: identical ids in different sessions are distinct,
		// and the TTL window bounds the dedupe memory.
		assert.notEqual(
			buildCompletionKey({ id: "run-123", sessionId: "session-a" }, "fallback"),
			buildCompletionKey({ id: "run-123", sessionId: "session-b" }, "fallback"),
		);
		const seen = new Map<string, number>();
		assert.equal(markSeenWithTtl(seen, "k", 100, 1000), false);
		assert.equal(markSeenWithTtl(seen, "k", 200, 1000), true);
		assert.equal(markSeenWithTtl(seen, "k", 1201, 1000), false);
	});
});
