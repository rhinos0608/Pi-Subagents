import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createScheduledRunManager } from "../../src/runs/background/scheduled-runs.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-internal-route-"));
	const initialOwner = randomUUID();
	const context = (owner = initialOwner, file: string | null = path.join(root, "parent.jsonl")) => ({
		cwd: root, hasUI: false,
		sessionManager: { getSessionId: () => owner, getSessionFile: () => file, getEntries: () => [] },
	});
	const state: SubagentState = {
		baseCwd: root, currentSessionId: context().sessionManager.getSessionFile(), supervisorOwnerSessionId: initialOwner,
		asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null,
		poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear() {} },
	};
	const pi = {
		getAllTools: () => [], registerTool() {}, getSessionName: () => "parent",
		events: { emit() {}, on() { return () => {}; } },
		sendMessage() {},
	};
	const config = { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as never;
	const executor = createSubagentExecutor({
		pi: pi as never, state, config, asyncByDefault: false, tempArtifactsDir: root,
		getSubagentSessionRoot: () => root, expandTilde: value => value, discoverAgents: () => ({ agents: [] }),
		activateSupervisorTransport() {}, refreshResultDelivery() {},
	});
	const manager = createScheduledRunManager({ config, storeRoot: path.join(root, "schedules"),
		launch: (params, ctx, signal) => executor.executeScheduled(randomUUID(), params, signal, ctx),
	});
	const cleanupDirs: string[] = [];
	return {
		root, context, state, executor, manager,
		async dispose() {
			manager.stop();
			for (const dir of [...cleanupDirs, root]) fs.rmSync(dir, { recursive: true, force: true });
		},
		track(dir: string) { cleanupDirs.push(dir); },
	};
}

describe("scheduled internal route", () => {
	it("scheduler-owned internal fields succeed through executeScheduled but fail through executePublic", async () => {
		const f = fixture();
		try {
			const ctx = f.context() as never;
			const id = randomUUID();
			const created = await f.manager.handleToolCall({
				action: "schedule.create", id, at: "+1h",
				workflowScript: "return args.who;",
				args: { who: "sched" },
			}, ctx);
			assert.equal(created.isError, undefined, JSON.stringify(created));

			const launched = await f.manager.handleToolCall({ action: "schedule.run", id }, ctx);
			const run = launched.details!.schedules!.runs![0]!;
			assert.equal(run.state, "running", JSON.stringify(launched));
			f.track(run.asyncDir!);

			// Model-authored equivalent through the public gate must fail: args are scheduler-owned internals.
			const rejected = await f.executor.executePublic(randomUUID(), {
				workflowScript: "return args.who;",
				args: { who: "sched" },
				scheduleOrigin: { id },
				async: true,
				mission: false,
				cwd: f.root,
			} as never, new AbortController().signal, undefined, ctx);
			assert.equal(rejected.isError, true, JSON.stringify(rejected));
			assert.match(JSON.stringify(rejected), /args were removed/);
		} finally { await f.dispose(); }
	});
});
