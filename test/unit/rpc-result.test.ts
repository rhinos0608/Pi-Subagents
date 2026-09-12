import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";
import { SUBAGENT_RPC_PROTOCOL_VERSION, SUBAGENT_RPC_REQUEST_EVENT, registerSubagentRpcBridge, subagentRpcReplyEvent } from "../../src/extension/rpc.ts";
import { writeAsyncResultFile } from "../../src/runs/background/result-files.ts";
import { writeCompletionReplay } from "../../src/runs/background/completion-replay.ts";

class Events {
	private handlers = new Map<string, Array<(value: unknown) => void>>();
	on(event: string, handler: (value: unknown) => void): () => void { const list = this.handlers.get(event) ?? []; list.push(handler); this.handlers.set(event, list); return () => this.handlers.set(event, (this.handlers.get(event) ?? []).filter((item) => item !== handler)); }
	emit(event: string, value: unknown): void { for (const handler of [...(this.handlers.get(event) ?? [])]) handler(value); }
}
function context(session = "session-a") { return { cwd: "/repo", sessionManager: { getSessionId: () => session, getSessionFile: () => `/sessions/${session}.jsonl` } } as any; }
async function request(events: Events, id: string, method: string, params?: unknown): Promise<any> { const reply = new Promise<any>((resolve) => events.on(subagentRpcReplyEvent(id), resolve)); events.emit(SUBAGENT_RPC_REQUEST_EVENT, { version: SUBAGENT_RPC_PROTOCOL_VERSION, requestId: id, method, ...(params === undefined ? {} : { params }) }); return reply; }
function setup(extra: Record<string, unknown> = {}) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-result-")); const runs = path.join(root, "runs"); const results = path.join(root, "results"); const events = new Events(); const bridge = registerSubagentRpcBridge({ events, getContext: () => context(), execute: async () => ({ content: [] } as any), asyncDirRoot: runs, resultsDir: results, ...extra }); return { root, runs, results, events, bridge }; }
function writeResult(results: string, runId: string, sessionId = "/sessions/session-a.jsonl", data: Record<string, unknown> = {}) { const file = path.join(results, `${runId}.json`); fs.mkdirSync(path.dirname(file), { recursive: true }); writeAsyncResultFile(file, { runId, id: runId, sessionId, state: "complete", success: true, ...data }); }
function writeStatus(runs: string, runId: string, state: string, sessionId = "/sessions/session-a.jsonl") { fs.mkdirSync(path.join(runs, runId), { recursive: true }); fs.writeFileSync(path.join(runs, runId, "status.json"), JSON.stringify({ runId, state, sessionId })); }
async function result(env: ReturnType<typeof setup>, runId: string, params?: Record<string, unknown>) { const reply = await request(env.events, runId, "result", params ?? { runId }); assert.equal(reply.success, true); return reply.data; }
function close(env: ReturnType<typeof setup>) { env.bridge.dispose(); fs.rmSync(env.root, { recursive: true, force: true }); }

describe("RPC result", () => {
	it("advertises result capability via ping", async () => { const env = setup(); try { const reply = await request(env.events, "ping", "ping"); assert.equal(reply.data.capabilities.result, true); } finally { close(env); } });
	it("returns pending live runs and maps terminal outcomes", async () => { const env = setup(); try { writeStatus(env.runs, "pending", "running"); assert.deepEqual(await result(env, "pending"), { runId: "pending", ready: false, state: "running" }); for (const [state, outcome] of [["complete", "success"], ["failed", "failure"], ["rejected", "failure"], ["stopped", "stopped"], ["paused", "paused"]] as const) { writeStatus(env.runs, state, state); assert.equal((await result(env, state)).outcome, outcome); } } finally { close(env); } });
	it("reads indexed output and concatenates child outputs", async () => { const env = setup(); try { writeResult(env.results, "indexed", undefined, { output: "hello" }); assert.equal((await result(env, "indexed")).output, "hello"); writeResult(env.results, "children", undefined, { results: [{ output: "one" }, { output: "two" }] }); assert.equal((await result(env, "children")).output, "onetwo"); } finally { close(env); } });
	it("propagates indexed payload truncation metadata", async () => { const env = setup(); try { writeResult(env.results, "truncated-index", undefined, { results: [{ output: "partial", truncated: true }] }); assert.equal((await result(env, "truncated-index")).outputTruncated, true); } finally { close(env); } });
	it("scopes same run ids to session", async () => { const env = setup(); try { writeResult(env.results, "shared", "/sessions/session-b.jsonl", { output: "foreign" }); const reply = await request(env.events, "shared", "result", { runId: "shared" }); assert.equal(reply.success, false); assert.equal(reply.error.code, "not_found"); } finally { close(env); } });
	it("scopes async status fallback to session", async () => { const env = setup(); try { writeStatus(env.runs, "status-foreign", "complete", "/sessions/session-b.jsonl"); const reply = await request(env.events, "status-foreign", "result", { runId: "status-foreign" }); assert.equal(reply.success, false); assert.equal(reply.error.code, "not_found"); } finally { close(env); } });
	it("rejects traversal and whitespace run ids", async () => { const env = setup(); try { for (const runId of ["../secret", " run", "run ", "a/b"]) { const reply = await request(env.events, `bad-${runId}`, "result", { runId }); assert.equal(reply.success, false); assert.equal(reply.error.code, "invalid_params"); } } finally { close(env); } });
	it("evicts oldest result cache entries", async () => { const env = setup({ maxResultCacheEntries: 1 }); try { writeResult(env.results, "first", undefined, { output: "1" }); writeResult(env.results, "second", undefined, { output: "2" }); await result(env, "first"); await result(env, "second"); fs.rmSync(path.join(env.results, "first.json")); fs.rmSync(path.join(env.results, "second.json")); assert.equal((await result(env, "second")).output, "2"); const reply = await request(env.events, "first-again", "result", { runId: "first" }); assert.equal(reply.success, false); assert.equal(reply.error.code, "not_found"); } finally { close(env); } });
	it("truncates Unicode without splitting surrogate pairs", async () => { const env = setup({ resultOutputCapChars: 2 }); try { writeResult(env.results, "unicode", undefined, { output: "a😀b" }); assert.equal((await result(env, "unicode")).output, "😀b"); } finally { close(env); } });
	it("keeps empty output empty when cap is zero", async () => { const env = setup({ resultOutputCapChars: 0 }); try { assert.deepEqual((writeResult(env.results, "empty", undefined, { output: "" }), await result(env, "empty")), { runId: "empty", ready: true, state: "complete", outcome: "success", output: "", outputAvailable: false, outputTruncated: false }); } finally { close(env); } });
	it("reports no active session", async () => { const env = setup({ getContext: () => ({ sessionManager: { getSessionId: () => null, getSessionFile: () => null } }) }); try { const reply = await request(env.events, "none", "result", { runId: "none" }); assert.equal(reply.success, false); assert.equal(reply.error.code, "no_active_session"); } finally { close(env); } });
	it("reads short archive files without trailing heap garbage", async () => {
		const env = setup();
		try {
			const shortFile = path.join(env.root, "short.txt");
			fs.writeFileSync(shortFile, "hi", "utf-8");
			writeCompletionReplay({
				resultsDir: env.results,
				runId: "shortfile",
				sessionId: "/sessions/session-a.jsonl",
				completion: { runId: "shortfile", state: "complete", success: true } as any,
				data: { results: [{ agent: "worker", sessionFile: shortFile }] },
				now: Date.now(),
				ttlMs: 60_000,
			});
			const data = await result(env, "shortfile");
			assert.equal(data.output, "hi");
			assert.equal(data.output.length, 2);
		} finally { close(env); }
	});
	it("caches terminal completion summary and source truncation", async () => { const env = setup({ resultOutputCapChars: 100 }); try { env.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "event-cached", sessionId: "/sessions/session-a.jsonl", state: "complete", summary: "terminal summary", truncated: true }); assert.deepEqual(await result(env, "event-cached"), { runId: "event-cached", ready: true, state: "complete", outcome: "success", output: "terminal summary", outputAvailable: true, outputTruncated: true }); } finally { close(env); } });
});
