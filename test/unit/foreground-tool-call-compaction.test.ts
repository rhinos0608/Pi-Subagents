import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactForegroundResult } from "../../utils.ts";
import { formatToolCall } from "../../formatters.ts";

describe("foreground tool-call compaction", () => {
	it("stores compact tool-call summaries instead of raw message payloads", () => {
		const result = compactForegroundResult({
			agent: "tester",
			task: "run checks",
			exitCode: 0,
			messages: [{
				role: "assistant",
				content: [{
					type: "toolCall",
					name: "write",
					arguments: {
						path: "/tmp/report.md",
						content: "x".repeat(50_000),
					},
				}],
			}],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		});

		assert.equal(result.messages, undefined);
		assert.deepEqual(result.toolCalls, [{
			text: "write /tmp/report.md",
			expandedText: "write /tmp/report.md",
		}]);
	});

	it("keeps expanded generic tool-call previews bounded", () => {
		const collapsed = formatToolCall("custom", { payload: "x".repeat(500) });
		const expanded = formatToolCall("custom", { payload: "x".repeat(500) }, true);

		assert.ok(expanded.length > collapsed.length);
		assert.ok(expanded.length < 200);
	});

	it("does not keep an empty toolCalls array after compaction", () => {
		const result = compactForegroundResult({
			agent: "tester",
			task: "run checks",
			exitCode: 0,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		});

		assert.equal(result.toolCalls, undefined);
	});
});
