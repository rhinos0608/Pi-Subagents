import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SUBAGENT_RPC_PROTOCOL_VERSION, SUBAGENT_RPC_REQUEST_EVENT, registerSubagentRpcBridge, subagentRpcReplyEvent, type SubagentRpcReplyEnvelope } from "../../src/extension/rpc.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";
import { writeAsyncResultFile } from "../../src/runs/background/result-files.ts";

class Events {
	private handlers = new Map<string, Array<(value: unknown) => void>>();
	on(event: string, handler: (value: unknown) => void): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => this.handlers.set(event, (this.handlers.get(event) ?? []).filter((item) => item !== handler));
	}
	emit(event: string, value: unknown): void { for (const handler of [...(this.handlers.get(event) ?? [])]) handler(value); }
}

function context(session = "session-a") {
	return { cwd: "/repo", sessionManager: { getSessionId: () => session, getSessionFile: () => `/sessions/${session}.jsonl` } } as any;
}

async function request(events: Events, id: string, method: string, params?: unknown): Promise<SubagentRpcReplyEnvelope> {
	const reply = new Promise<SubagentRpcReplyEnvelope>((resolve) => events.on(subagentRpcReplyEvent(id), resolve));
	events.emit(SUBAGENT_RPC_REQUEST_EVENT, { version: SUBAGENT_RPC_PROTOCOL_VERSION, requestId: id, method, ...(params === undefined ? {} : { params }) });
	return reply;
}

function setup(extra: Record<string, unknown> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-result-"));
	const runs = path.join(root, "runs");
	const results = path.join(root, "results");
	const events = new Events();
	const bridge = registerSubagentRpcBridge({ events, getContext: () => context(), execute: async () => ({ content: [] } as any), asyncDirRoot: runs, resultsDir: results, ...extra });
	return { root, runs, results, events, bridge };
}

function writeResult(results: string, runId: string, sessionId = "/sessions/session-a.jsonl", data: Record<string, unknown> = {}) {
	const file = path.join(results, `${runId}.json`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeAsyncResultFile(file, { runId, id: runId, sessionId, state: "complete", success: true, ...data });
}

function writeStatus(runs: string, runId: string, state: string, sessionId = "/sessions/session-a.jsonl") {
	fs.mkdirSync(path.join(runs, runId), { recursive: true });
	fs.writeFileSync(path.join(runs, runId, "status.json"), JSON.stringify({ runId, state, sessionId }));
}

async function result(env: ReturnType<typeof setup>, runId: string, params?: Record<string, unknown>) {
	const reply = await request(env.events, runId, "result", params ?? { runId });
	assert.equal(reply.success, true);
	return (reply as { data: any }).data;
}

function close(env: ReturnType<typeof setup>) { env.bridge.dispose(); fs.rmSync(env.root, { recursive: true, force: true }); }

describe("RPC result", () => {
	it("advertises result capability via ping", async () => {
		const env = setup();
		try { const reply = await request(env.events, "ping", "ping"); assert.equal((reply as any).data.capabilities.result, true); }
		finally { close(env); }
	});

	it("returns pending live runs and maps terminal outcomes", async () => {
		const env = setup();
		try {
			writeStatus(env.runs, "pending", "running");
			assert.deepEqual(await result(env, "pending"), { runId: "pending", ready: false, state: "running" });
			for (const [state, outcome] of [["complete", "success"], ["failed", "failure"], ["rejected", "failure"], ["stopped", "stopped"], ["paused", "paused"]] as const) {
				writeStatus(env.runs, state, state);
				assert.equal((await result(env, state)).outcome, outcome);
			}
		} finally { close(env); }
	});

	it("does not cache pending results before terminal output is created", async () => {
		const env = setup();
		try {
			writeStatus(env.runs, "transitioning", "running");
			assert.deepEqual(await result(env, "transitioning"), { runId: "transitioning", ready: false, state: "running" });
			writeResult(env.results, "transitioning", "/sessions/session-a.jsonl", { output: "finished" });
			assert.equal((await result(env, "transitioning")).ready, true);
			assert.equal((await result(env, "transitioning")).output, "finished");
		} finally { close(env); }
	});

	it("keeps terminal results cached after source disappears", async () => {
		const env = setup();
		try {
			writeResult(env.results, "cached", "/sessions/session-a.jsonl", { output: "retained" });
			assert.equal((await result(env, "cached")).output, "retained");
			fs.rmSync(path.join(env.results, "cached.json"));
			assert.deepEqual(await result(env, "cached"), { runId: "cached", ready: true, state: "complete", outcome: "success", output: "retained", outputAvailable: true, outputTruncated: false });
		} finally { close(env); }
	});

	it("caches completion summary after result file disappears", async () => {
		const env = setup({ resultOutputCapChars: 100 });
		try {
			env.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				runId: "event-cached",
				sessionId: "/sessions/session-a.jsonl",
				state: "complete",
				summary: "terminal summary",
				truncated: true,
			});
			assert.deepEqual(await result(env, "event-cached"), {
				runId: "event-cached",
				ready: true,
				state: "complete",
				outcome: "success",
				output: "terminal summary",
				outputAvailable: true,
				outputTruncated: true,
			});
		} finally { close(env); }
	});

	it("reads indexed output and concatenates child outputs", async () => {
		const env = setup();
		try {
			writeResult(env.results, "indexed", "/sessions/session-a.jsonl", { output: "hello" });
			assert.deepEqual(await result(env, "indexed"), { runId: "indexed", ready: true, state: "complete", outcome: "success", output: "hello", outputAvailable: true, outputTruncated: false });
			writeResult(env.results, "children", "/sessions/session-a.jsonl", { results: [{ output: "one" }, { output: "two" }] });
			assert.equal((await result(env, "children")).output, "onetwo");
		} finally { close(env); }
	});

	it("propagates indexed payload truncation metadata", async () => {
		const env = setup();
		try {
			writeResult(env.results, "truncated-index", "/sessions/session-a.jsonl", { results: [{ output: "partial", truncated: true }] });
			assert.equal((await result(env, "truncated-index")).outputTruncated, true);
		} finally { close(env); }
	});

	it("scopes same run ids to session", async () => {
		const env = setup();
		try {
			writeResult(env.results, "shared", "/sessions/session-b.jsonl", { output: "foreign" });
			const reply = await request(env.events, "shared", "result", { runId: "shared" });
			assert.equal(reply.success, false); assert.equal((reply as any).error.code, "not_found");
		} finally { close(env); }
	});

	it("rejects traversal and whitespace run ids", async () => {
		const env = setup();
		try {
			for (const runId of ["../secret", " run", "run ", "a/b"]) {
				const reply = await request(env.events, `bad-${runId}`, "result", { runId });
				assert.equal(reply.success, false); assert.equal((reply as any).error.code, "invalid_params");
			}
		} finally { close(env); }
	});

	it("evicts oldest result cache entries", async () => {
		const env = setup({ maxResultCacheEntries: 1 });
		try {
			writeResult(env.results, "first", "/sessions/session-a.jsonl", { output: "1" });
			writeResult(env.results, "second", "/sessions/session-a.jsonl", { output: "2" });
			await result(env, "first"); await result(env, "second");
			fs.rmSync(path.join(env.results, "first.json")); fs.rmSync(path.join(env.results, "second.json"));
			assert.equal((await result(env, "second")).output, "2");
			const reply = await request(env.events, "first-again", "result", { runId: "first" });
			assert.equal(reply.success, false); assert.equal((reply as any).error.code, "not_found");
		} finally { close(env); }
	});

	it("truncates Unicode without splitting surrogate pairs", async () => {
		const env = setup({ resultOutputCapChars: 2 });
		try { writeResult(env.results, "unicode", "/sessions/session-a.jsonl", { output: "a😀b" }); assert.equal((await result(env, "unicode")).output, "😀b"); }
		finally { close(env); }
	});

	it("keeps empty output empty when cap is zero", async () => {
		const env = setup({ resultOutputCapChars: 0 });
		try { writeResult(env.results, "empty", "/sessions/session-a.jsonl", { output: "" }); assert.deepEqual(await result(env, "empty"), { runId: "empty", ready: true, state: "complete", outcome: "success", output: "", outputAvailable: false, outputTruncated: false }); }
		finally { close(env); }
	});

	it("reports no active session", async () => {
		const env = setup({ getContext: () => ({ sessionManager: { getSessionId: () => null, getSessionFile: () => null } }) });
		try { const reply = await request(env.events, "none", "result", { runId: "none" }); assert.equal(reply.success, false); assert.equal((reply as any).error.code, "no_active_session"); }
		finally { close(env); }
	});
});
