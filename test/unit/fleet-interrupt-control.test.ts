import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { consumeInterruptRequest, interruptRequestPath } from "../../src/runs/background/control-channel.ts";
import { buildDefaultFleetActions, SubagentFleetComponent } from "../../src/tui/fleet.ts";

function state() {
	return {
		baseCwd: os.tmpdir(),
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as never;
}

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const markdownTheme = {
	heading: (text: string) => text,
	link: (text: string) => text,
	linkUrl: (text: string) => text,
	code: (text: string) => text,
	codeBlock: (text: string) => text,
	codeBlockBorder: (text: string) => text,
	quote: (text: string) => text,
	quoteBorder: (text: string) => text,
	hr: (text: string) => text,
	listBullet: (text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
};

function writeRunningStatus(asyncDir: string, overrides: Record<string, unknown> = {}): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: "run-123",
		mode: "single",
		state: "running",
		pid: 4242,
		cwd: os.tmpdir(),
		startedAt: 100,
		lastUpdate: Date.now(),
		steps: [{ agent: "worker", status: "running", startedAt: 100 }],
		...overrides,
	}));
}

describe("fleet default controls (phase 7c)", () => {
	it("exposes interrupt-as-pause alongside the untouched stop control", () => {
		const actions = buildDefaultFleetActions(state());
		assert.equal(typeof actions.steer, "function");
		assert.equal(typeof actions.stop, "function");
		assert.equal(typeof actions.interrupt, "function");
		// No resume delegate means no resume slot: no fake default may fire it.
		assert.equal(actions.resume, undefined);
		const wired = buildDefaultFleetActions(state(), {
			resumeRun: () => ({ content: [{ type: "text", text: "Resumed." }], details: { mode: "management", results: [] } }) as never,
		});
		assert.equal(typeof wired.resume, "function");
	});

	it("interrupt requests a resumable pause on a running single run", () => {
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-interrupt-"));
		try {
			writeRunningStatus(asyncDir);
			const tracked = { asyncId: "run-123", asyncDir, status: "running", activityState: { current: "working" }, updatedAt: 1 };
			const st = state() as { asyncJobs: Map<string, Record<string, unknown>> };
			st.asyncJobs.set("run-123", tracked);
			const actions = buildDefaultFleetActions(st as never);
			const result = actions.interrupt!({ runId: "run-123", asyncDir });
			assert.deepEqual(result, { text: "Interrupt requested for async run run-123." });
			assert.ok(fs.existsSync(interruptRequestPath(asyncDir)), "interrupt request file must exist");
			const payload = JSON.parse(fs.readFileSync(interruptRequestPath(asyncDir), "utf-8")) as { source?: string };
			assert.equal(payload.source, "fleet-interrupt");
			assert.equal(consumeInterruptRequest(asyncDir), true);
			assert.equal(tracked.activityState, undefined);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("fleet interrupt fires through component input on the selected run", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-component-interrupt-"));
		const startedAt = Date.now();
		const asyncDir = path.join(root, "run-123");
		fs.mkdirSync(asyncDir, { recursive: true });
		writeRunningStatus(asyncDir, { runId: "run-123", sessionId: "session-current", startedAt });
		try {
			const st = state();
			st.asyncJobs.set("run-123", {
				asyncId: "run-123",
				asyncDir,
				sessionId: "session-current",
				status: "running",
				mode: "single",
				startedAt,
				updatedAt: startedAt,
			});
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				st,
				() => {},
				{ refreshMs: 60_000, markdownTheme: markdownTheme as never, actions: buildDefaultFleetActions(st, {}) },
			);
			try {
				assert.ok(component.render(100).some((line) => line.includes("run-123")));
				component.handleInput("i");
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(consumeInterruptRequest(asyncDir), true);
				assert.match(component.render(100).join("\n"), /Interrupt requested for async run run-123/);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fleet resume fires through component input and reports executor refusal honestly", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-component-resume-"));
		const startedAt = Date.now();
		const asyncDir = path.join(root, "run-123");
		fs.mkdirSync(asyncDir, { recursive: true });
		writeRunningStatus(asyncDir, { runId: "run-123", sessionId: "session-current", startedAt });
		const resumeCalls: Array<{ runId: string; message: string }> = [];
		try {
			const st = state();
			st.asyncJobs.set("run-123", {
				asyncId: "run-123",
				asyncDir,
				sessionId: "session-current",
				status: "running",
				mode: "single",
				startedAt,
				updatedAt: startedAt,
			});
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				st,
				() => {},
				{
					refreshMs: 60_000,
					markdownTheme: markdownTheme as never,
					actions: buildDefaultFleetActions(st, {
						resumeRun: (input: { runId: string; message: string }) => {
							resumeCalls.push({ runId: input.runId, message: input.message });
							return { content: [{ type: "text", text: "Run run-123 is still running; only paused runs can resume." }], isError: true, details: { mode: "management", results: [] } } as never;
						},
					}),
				},
			);
			try {
				assert.ok(component.render(100).some((line) => line.includes("run-123")));
				component.handleInput("u");
				assert.match(component.render(100).join("\n"), /Resume message:/);
				for (const char of "continue from checkpoint") component.handleInput(char);
				component.handleInput("\r");
				await new Promise((resolve) => setImmediate(resolve));
				assert.deepEqual(resumeCalls, [{ runId: "run-123", message: "continue from checkpoint" }]);
				assert.match(component.render(100).join("\n"), /still running; only paused runs can resume/);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("interrupt refuses non-running, workflow, and external runs", () => {
		const actions = buildDefaultFleetActions(state());
		const stoppedDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-interrupt-stopped-"));
		const workflowDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-interrupt-workflow-"));
		const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-interrupt-external-"));
		try {
			writeRunningStatus(stoppedDir, { state: "paused" });
			assert.deepEqual(
				actions.interrupt!({ runId: "run-123", asyncDir: stoppedDir }),
				{ text: "No running async run with an interrupt-capable pid was found for 'run-123'.", isError: true },
			);
			writeRunningStatus(workflowDir, { mode: "workflow" });
			assert.deepEqual(
				actions.interrupt!({ runId: "run-123", asyncDir: workflowDir }),
				{ text: "Interrupt is unsupported for async workflow run-123; use stop instead.", isError: true },
			);
			writeRunningStatus(externalDir, { steps: [{ agent: "ext", status: "running", runner: { type: "external-cli" } }] });
			assert.deepEqual(
				actions.interrupt!({ runId: "run-123", asyncDir: externalDir }),
				{ text: "Interrupt is unsupported for external async run run-123; use stop instead.", isError: true },
			);
		} finally {
			for (const dir of [stoppedDir, workflowDir, externalDir]) fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
