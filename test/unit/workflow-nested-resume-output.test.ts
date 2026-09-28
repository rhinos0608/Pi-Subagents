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

function nestedResumeFixture(root: string, child: any, agents: any[] = []) {
	const route = createNestedRoute("root-control");
	routeRoots.push(path.dirname(route.eventSink));
	writeNestedEvent(route, {
		type: "subagent.nested.updated",
		ts: 100,
		parentRunId: "root-control",
		parentStepIndex: 0,
		child,
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
		discoverAgents: () => ({ agents }),
		allowMutatingManagementActions: true,
	});
	return { route, executor };
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
			const { route, executor } = nestedResumeFixture(root, {
				id: "nested-live-resume", parentRunId: "root-control", parentStepIndex: 0, depth: 1,
				path: [{ runId: "root-control", stepIndex: 0 }], state: "running", agent: "worker", ownerState: "live",
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
			const { executor } = nestedResumeFixture(root, {
				id: "nested-stopped-resume", parentRunId: "root-control", parentStepIndex: 0, depth: 1,
				path: [{ runId: "root-control", stepIndex: 0 }], state: "stopped", agent: "worker", ownerState: "gone",
				sessionFile: path.join(root, "missing-session.jsonl"),
			}, [{ name: "worker", description: "Worker", prompt: "Do work" }] as any);
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

	/**
	 * Claim admission enforces the same exactness as launch: a prefix of a
	 * live nested id must not be admitted by the nested check. Before the
	 * exactOnly fix the prefix matched admission, skipped output inheritance,
	 * and failed later with a confusing downstream error. Now the prefix falls
	 * through to output inheritance and reports the authoritative "Async run
	 * not found" error, identical to a fully unknown id.
	 */
	it(`rejects nested-id prefixes at claim admission with the authoritative not-found error`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-resume-prefix-"));
		try {
			const { executor } = nestedResumeFixture(root, {
				id: "nested-live-prefix-target-abcdef", parentRunId: "root-control", parentStepIndex: 0, depth: 1,
				path: [{ runId: "root-control", stepIndex: 0 }], state: "running", agent: "worker", ownerState: "live",
			}, [{ name: "worker", description: "Worker", prompt: "Do work" }] as any);
		const run = (resume: string) => executor.execute("resume", {
			async: false,
			workflowScript: `return runs.run("p", { resume: ${JSON.stringify(resume)}, task: "continue" });`,
		}, new AbortController().signal, undefined, ctx(root));
		const prefix = await run("nested-live-prefix-target");
		assert.equal(prefix.isError, true);
		assert.match(text(prefix), /Async run not found\. Provide id or dir\./);
		const unknown = await run("no-such-run-anywhere");
			assert.equal(unknown.isError, true);
			assert.match(text(unknown), /Async run not found\. Provide id or dir\./);
				const withoutMission = (value: string) => value.split("\n").filter((line) => !line.startsWith("Mission:")).join("\n");
			assert.equal(withoutMission(text(prefix)), withoutMission(text(unknown)));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
