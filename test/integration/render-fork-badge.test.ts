import assert from "node:assert/strict";
import { describe, it } from "node:test";

type RenderSubagentResult = (
	result: {
		content: Array<{ type: "text"; text: string }>;
		details?: {
			mode: "single" | "parallel" | "chain" | "management";
			context?: "fresh" | "fork";
			results: unknown[];
		};
	},
	options: { expanded: boolean },
	theme: {
		fg(name: string, text: string): string;
		bold(text: string): string;
	},
) => { render(width: number): string[] };

let renderSubagentResult: RenderSubagentResult | undefined;
({ renderSubagentResult } = await import("../../render.ts") as {
	renderSubagentResult?: RenderSubagentResult;
});

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function withTerminalWidth<T>(columns: number, fn: () => T): T {
	const original = process.stdout.columns;
	Object.defineProperty(process.stdout, "columns", {
		value: columns,
		configurable: true,
	});
	try {
		return fn();
	} finally {
		Object.defineProperty(process.stdout, "columns", {
			value: original,
			configurable: true,
		});
	}
}

describe("renderSubagentResult fork indicator", () => {
	it("shows [fork] when details are empty but context is fork", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "Async: reviewer [abc123]" }],
			details: { mode: "single", context: "fork", results: [] },
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /\[fork\]/);
	});

	it("shows [fork] on single-result header", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				context: "fork",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						turns: 0,
					},
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /\[fork\]/);
	});

	it("uses compacted tool-call summaries when messages were stripped", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: undefined,
					toolCalls: [{
						text: "$ npm test -- --watch...",
						expandedText: "$ npm test -- --watch --runInBand --reporter=dot",
					}],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						turns: 0,
					},
				}],
			},
		}, { expanded: true }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /npm test -- --watch --runInBand --reporter=dot/);
	});

	it("shows the full task in expanded mode", () => {
		const longTask = "Review the auth flow, trace the race condition, and document the precise failing tool sequence at the end.";
		const collapsed = withTerminalWidth(40, () => renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: longTask,
					exitCode: 0,
					messages: [],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						turns: 0,
					},
				}],
			},
		}, { expanded: false }, theme).render(40).join("\n"));

		const expanded = withTerminalWidth(40, () => renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: longTask,
					exitCode: 0,
					messages: [],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						turns: 0,
					},
				}],
			},
		}, { expanded: true }, theme).render(40).join("\n"));

		const unwrap = (text: string) => text.replace(/\s+/g, "");
		assert.doesNotMatch(unwrap(collapsed), /precisefailingtoolsequenceattheend\./);
		assert.match(unwrap(expanded), /precisefailingtoolsequenceattheend\./);
	});

	it("shows live detail hints for running subagents", () => {
		const now = Date.now();
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					artifactPaths: {
						outputPath: "/tmp/reviewer_output.md",
					},
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						turns: 0,
					},
					progress: {
						index: 0,
						agent: "reviewer",
						status: "running",
						task: "review",
						lastActivityAt: now - 2_000,
						currentTool: "read",
						currentToolArgs: "package.json",
						currentToolStartedAt: now - 3_000,
						recentTools: [],
						recentOutput: [],
						toolCount: 1,
						tokens: 42,
						durationMs: 3_000,
					},
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /Press Ctrl\+O for live detail/);
		assert.match(text, /active 2s ago/);
		assert.match(text, /> read: package\.json \| 3\.0s/);
		assert.match(text, /Artifacts: \/tmp\/reviewer_output\.md/);
	});

	it("uses the tracked progress index for live parallel step labels", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "parallel",
				totalSteps: 3,
				results: [{
					agent: "worker",
					task: "third task",
					exitCode: 0,
					messages: [],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						turns: 0,
					},
					progress: {
						index: 2,
						agent: "worker",
						status: "running",
						task: "third task",
						recentTools: [],
						recentOutput: [],
						toolCount: 1,
						tokens: 0,
						durationMs: 10,
					},
				}],
				progress: [{
					index: 2,
					agent: "worker",
					status: "running",
					task: "third task",
					recentTools: [],
					recentOutput: [],
					toolCount: 1,
					tokens: 0,
					durationMs: 10,
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /Step 3: worker/);
		assert.doesNotMatch(text, /Step 1: worker/);
	});
});
