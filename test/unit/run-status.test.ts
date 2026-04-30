import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function textContent(result: ReturnType<typeof inspectSubagentStatus>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

describe("async run status inspection", () => {
	it("repairs stale running status and reports diagnosis plus result path", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-stale-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-stale");
			fs.mkdirSync(asyncDir, { recursive: true });
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-stale",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				currentStep: 0,
				sessionFile,
				steps: [{ agent: "scout", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-stale" }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 200,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /State: failed/);
			assert.match(text, /Diagnosis: Async runner process 12345 exited or disappeared/);
			assert.match(text, new RegExp(`Result: ${path.join(resultsDir, "run-stale.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.match(text, /Step 1: scout failed, error: Async runner process 12345 exited or disappeared/);
			assert.match(text, /Revive: subagent\(\{ action: "resume", id: "run-stale", message: "\.\.\." \}\)/);
			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-stale.json"), "utf-8"));
			assert.equal(resultJson.success, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows expected intercom target for still-running async steps", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-intercom-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-live");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-live",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "scout", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-live" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const text = textContent(result);
			assert.match(text, /Step 1: scout running/);
			assert.match(text, /Intercom target: subagent-scout-run-live-1 \(if registered\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects ambiguous async run id prefixes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-ambiguous-"));
		try {
			const asyncRoot = path.join(root, "runs");
			fs.mkdirSync(path.join(asyncRoot, "run-aa"), { recursive: true });
			fs.mkdirSync(path.join(asyncRoot, "run-ab"), { recursive: true });

			const result = inspectSubagentStatus({ id: "run-a" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
			});

			assert.equal(result.isError, true);
			assert.match(textContent(result), /Ambiguous async run id prefix 'run-a'/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects path-like async run ids", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-paths-"));
		try {
			const result = inspectSubagentStatus({ id: "../run" }, {
				asyncDirRoot: path.join(root, "runs"),
				resultsDir: path.join(root, "results"),
			});

			assert.equal(result.isError, true);
			assert.match(textContent(result), /id must be an async run id or prefix, not a path/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to an existing result when async dir has no status file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-result-fallback-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "run-result-only"), { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(resultsDir, "run-result-only.json"), JSON.stringify({
				id: "run-result-only",
				agent: "worker",
				success: false,
				state: "failed",
				sessionFile,
				summary: "result survived missing status",
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-result-only" }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /State: failed/);
			assert.match(text, /Result: /);
			assert.match(text, /Revive: subagent\(\{ action: "resume", id: "run-result-only", message: "\.\.\." \}\)/);
			assert.match(text, /result survived missing status/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
