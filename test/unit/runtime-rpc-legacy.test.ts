/**
 * Legacy regression: `subagents:rpc:v1` constants and behavior stay
 * byte-for-byte unchanged by the runtime namespace addition.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	SUBAGENT_RPC_METHODS,
	SUBAGENT_RPC_PROTOCOL_VERSION,
	SUBAGENT_RPC_READY_EVENT,
	SUBAGENT_RPC_REPLY_EVENT_PREFIX,
	SUBAGENT_RPC_REQUEST_EVENT,
	subagentRpcReplyEvent,
} from "../../src/extension/rpc.ts";
import { RUNTIME_RPC_REPLY_EVENT_PREFIX, RUNTIME_RPC_REQUEST_EVENT } from "../../src/api/runtime-rpc.ts";

describe("legacy RPC namespace preserved", () => {
	it("keeps legacy event names and version", () => {
		assert.equal(SUBAGENT_RPC_PROTOCOL_VERSION, 1);
		assert.equal(SUBAGENT_RPC_REQUEST_EVENT, "subagents:rpc:v1:request");
		assert.equal(SUBAGENT_RPC_READY_EVENT, "subagents:rpc:v1:ready");
		assert.equal(SUBAGENT_RPC_REPLY_EVENT_PREFIX, "subagents:rpc:v1:reply:");
		assert.equal(subagentRpcReplyEvent("abc"), "subagents:rpc:v1:reply:abc");
		assert.deepEqual([...SUBAGENT_RPC_METHODS], ["ping", "status", "manage", "spawn", "steer", "interrupt", "stop", "resume", "result"]);
	});

	it("runtime namespace never collides with legacy", () => {
		assert.notEqual(RUNTIME_RPC_REQUEST_EVENT, SUBAGENT_RPC_REQUEST_EVENT);
		assert.notEqual(RUNTIME_RPC_REPLY_EVENT_PREFIX, SUBAGENT_RPC_REPLY_EVENT_PREFIX);
	});
});
