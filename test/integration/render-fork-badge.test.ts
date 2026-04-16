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
});
