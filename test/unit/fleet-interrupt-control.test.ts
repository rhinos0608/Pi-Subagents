import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { consumeInterruptRequest, interruptRequestPath } from "../../src/runs/background/control-channel.ts";
import { buildDefaultFleetActions } from "../../src/tui/fleet.ts";

function state() {
	return {
		baseCwd: os.tmpdir(),
		asyncJobs: new Map(),
	} as never;
}

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
		// Resume stays an optional injection slot: no fake default may fire it.
		assert.equal(actions.resume, undefined);
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
