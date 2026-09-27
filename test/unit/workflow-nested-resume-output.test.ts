import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createNestedRoute, readNestedControlRequests, writeNestedControlResult, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import type { SubagentState } from "../../src/shared/types.ts";

const routeRoots: string[] = [];

afterEach(() => {
	for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function ctx(root: string) {
	return {
		cwd: root,
		hasUI: false,
		sessionManager: { getSessionId() { return "session"; }, getSessionFile() { return null; } },
		modelRegistry: { getAvailable() { return []; } },
	} as any;
}

function text(result: Awaited<ReturnType<ReturnType<typeof createSubagentExecutor>["execute"]>>): string {
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

/**
 * Retained identity owns nested-resume routing: output persistence policy
 * (absent or truthy) must not decide resumability. Before the routing fix,
 * the output-claim admission resolved default/truthy-output resumes through
 * the foreground/async-only resolver, threw "Async run not found", and never
 * reached the control inbox. `output: false` only worked by accident (it
 * skipped the output-inheritance branch entirely).
 */
describe("workflow nested resume output routing", () => {
	it(`routes workflow string resume with default output through the control inbox`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-resume-output-"));
		try {
			const route = createNestedRoute("root-control");
			routeRoots.push(path.dirname(route.eventSink));
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: 100,
			parentRunId: "root-control",
			parentStepIndex: 0,
			child: { id: "nested-live-resume", parentRunId: "root-control", parentStepIndex: 0, depth: 1, path: [{ runId: "root-control", stepIndex: 0 }], state: "running", agent: "worker", ownerState: "live" },
			});
		const state = createState();
		state.foregroundControls.set(route.rootRunId, {
			runId: route.rootRunId,
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			nestedRoute: route,
			});
		state.lastForegroundControlId = route.rootRunId;
		const executor = createSubagentExecutor({
			pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as any,
			state,
			config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as any,
			asyncByDefault: false,
			tempArtifactsDir: os.tmpdir(),
			getSubagentSessionRoot: (parentSessionFile) => parentSessionFile ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl")) : os.tmpdir(),
			expandTilde: (value) => value,
			discoverAgents: () => ({ agents: [] }),
			allowMutatingManagementActions: true,
		});
		const responder = (async () => {
			const deadline = Date.now() + 2_000;
			let request = readNestedControlRequests(route)[0];
			while (!request && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				request = readNestedControlRequests(route)[0];
			}
			assert.ok(request, "expected a nested resume request");
			assert.equal(request.action, "resume");
			assert.equal(request.message, "continue please");
			writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "nested resume accepted" });
		})();
		const execution = Promise.resolve().then(() => executor.execute("resume", {
			async: false,
			workflowScript: `return runs.run("live", { resume: "nested-live-resume", task: "continue please" });`,
		}, new AbortController().signal, undefined, ctx(root)));
		const [response, executed] = await Promise.allSettled([responder, execution]);
		if (response.status === "rejected") throw response.reason;
		if (executed.status === "rejected") throw executed.reason;
		const result = executed.value;
		assert.equal(result.isError, undefined, text(result));
		assert.match(text(result), /nested resume accepted/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it(`reports stopped (not missing) for default-output workflow string resume of a stopped nested run`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-resume-output-stopped-"));
		try {
			const route = createNestedRoute("root-control");
			routeRoots.push(path.dirname(route.eventSink));
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: 100,
			parentRunId: "root-control",
			parentStepIndex: 0,
			child: { id: "nested-stopped-resume", parentRunId: "root-control", parentStepIndex: 0, depth: 1, path: [{ runId: "root-control", stepIndex: 0 }], state: "stopped", agent: "worker", ownerState: "gone", sessionFile: path.join(root, "missing-session.jsonl") },
			});
		const state = createState();
		state.foregroundControls.set(route.rootRunId, {
			runId: route.rootRunId,
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			nestedRoute: route,
			});
		state.lastForegroundControlId = route.rootRunId;
		const executor = createSubagentExecutor({
			pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as any,
			state,
			config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as any,
			asyncByDefault: false,
			tempArtifactsDir: os.tmpdir(),
			getSubagentSessionRoot: (parentSessionFile) => parentSessionFile ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl")) : os.tmpdir(),
			expandTilde: (value) => value,
			discoverAgents: () => ({ agents: [{ name: "worker", description: "Worker", prompt: "Do work" }] as any }),
			allowMutatingManagementActions: true,
		});
		const result = await executor.execute("resume", {
			async: false,
			workflowScript: `return runs.run("stopped", { resume: "nested-stopped-resume", task: "continue" });`,
		}, new AbortController().signal, undefined, ctx(root));
		assert.equal(result.isError, true);
		assert.match(text(result), /was stopped and cannot be resumed/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
