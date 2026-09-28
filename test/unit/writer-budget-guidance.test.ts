import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const readProjectFile = (file: string): string => readFileSync(join(process.cwd(), file), "utf-8");

describe("writer budget guidance", () => {
	it("keeps hard tool and usage caps off mutation-capable workers", () => {
		const toolReference = readProjectFile("docs/tool-reference.md");
		const skill = readProjectFile("skills/pi-subagents/SKILL.md");
		const reviewLoop = readProjectFile("prompts/review-loop.md");

		// Per-run/per-call toolBudget left the model surface, so no shipped
		// reference may tell writers to pass or set a hard toolBudget cap.
		for (const text of [toolReference, skill]) {
			assert.doesNotMatch(text, /do not (?:pass|set) a hard `toolBudget`/);
		}
		// The consolidated guidance lives in the skill: no tight budgets on
		// mutation-capable workers, checkpoint after the current tool returns.
		assert.match(skill, /do not set tight tool budgets on mutation-capable workers/i);
		assert.match(skill, /checkpoint after the current tool returns/);
		assert.match(skill, /changed files/);
		assert.match(skill, /build\/test state/);
		assert.match(skill, /commit or PR state/);

		// The review-loop prompt keeps the same durable checkpoint contract.
		assert.match(reviewLoop, /checkpoint after the current tool returns/);
		assert.match(reviewLoop, /changed files/);
		assert.match(reviewLoop, /build\/test state/);
		assert.match(reviewLoop, /commit or PR state/);
	});
});
