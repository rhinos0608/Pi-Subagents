import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
	createNativeSupervisorChannel,
	ensureSupervisorChannelDir,
	resolveSupervisorChannelDir,
} from "../../src/intercom/native-supervisor-channel.ts";
import type { SubagentState } from "../../src/shared/types.ts";

const createdChannels: string[] = [];

function makeState(sessionId: string, ctx: unknown): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: ctx as SubagentState["lastUiContext"],
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function writeRequest(input: { sessionId: string; runId: string; agent?: string; index?: number; message?: string }): string {
	const agent = input.agent ?? "worker";
	const index = input.index ?? 0;
	const channelDir = resolveSupervisorChannelDir(input.runId, agent, index);
	createdChannels.push(channelDir);
	ensureSupervisorChannelDir(channelDir);
	const requestId = randomUUID();
	fs.writeFileSync(path.join(channelDir, "requests", `${requestId}.json`), JSON.stringify({
		type: "subagent.supervisor.request",
		id: requestId,
		createdAt: Date.now(),
		reason: "need_decision",
		message: input.message ?? "Need a decision",
		expectsReply: true,
		orchestratorSessionId: input.sessionId,
		orchestratorTarget: "shared-name",
		runId: input.runId,
		agent,
		childIndex: index,
	}, null, "\t"));
	return requestId;
}

afterEach(() => {
	for (const channel of createdChannels.splice(0)) fs.rmSync(channel, { recursive: true, force: true });
});

describe("native supervisor channel", () => {
	it("delivers requests only to the exact current session id", () => {
		const currentSessionId = `session-${randomUUID()}`;
		const otherSessionId = `session-${randomUUID()}`;
		const matchingId = writeRequest({ sessionId: currentSessionId, runId: `run-${randomUUID()}` });
		const otherId = writeRequest({ sessionId: otherSessionId, runId: `run-${randomUUID()}` });
		const sent: Array<{ content?: string; details?: { id?: string } }> = [];
		const registeredTools: string[] = [];
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: {
				getSessionId: () => currentSessionId,
				getSessionFile: () => null,
				getEntries: () => [],
			},
		};
		const pi = {
			getAllTools: () => [],
			registerTool: (tool: { name: string }) => { registeredTools.push(tool.name); },
			sendMessage: (message: { content?: string; details?: { id?: string } }) => { sent.push(message); },
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

		channel.start();
		channel.dispose();

		assert.deepEqual(registeredTools, ["intercom"]);
		assert.deepEqual(sent.map((message) => message.details?.id), [matchingId]);
		assert.equal(channel.pending.has(matchingId), false, "disposed channel clears pending requests");
		assert.equal(sent.some((message) => message.details?.id === otherId), false);
	});
});
