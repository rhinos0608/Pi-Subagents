import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const readProjectFile = (file: string): string => readFileSync(join(process.cwd(), file), "utf-8");

describe("pi-subagents delegation policy guidance", () => {
	it("describes delegation tradeoffs without gating, mandating, or single-writer rules", () => {
		const skill = readProjectFile("skills/pi-subagents/SKILL.md");
		const prompting = readProjectFile("skills/pi-subagents/references/prompting-and-roles.md");
		const recipes = readProjectFile("skills/pi-subagents/references/constraints-and-recipes.md");
		const lanes = readProjectFile("skills/pi-subagents/references/multi-lane-orchestration.md");
		const review = readProjectFile("skills/pi-subagents/references/review-and-validation.md");
		const execution = readProjectFile("skills/pi-subagents/references/execution-controls.md");
		const management = readProjectFile("skills/pi-subagents/references/management-authoring-rpc.md");
		const guidance = [skill, prompting, recipes, lanes, review].join("\n");
		const allGuidance = [guidance, execution, management].join("\n");

		assert.match(skill, /pick\s+the shape whose benefit covers that overhead/is);

		// Concurrent-writer rule is worktree-FIRST when the tree is clean
		// (via `worktree: true` on workflow children; parent-created worktree
		// passed as cwd only for single launches), disjoint file ownership
		// otherwise, user single-writer override.
		// 'clean' + 'worktree' must precede 'otherwise' + 'disjoint'.
		assert.match(skill, /if git status is clean, pass `worktree: true`[\s\S]*otherwise give each writer disjoint file ownership/is);
		assert.match(lanes, /if git status is clean, pass `worktree: true`[\s\S]*otherwise give each writer disjoint file ownership/is);
		assert.match(review, /if git status is clean, pass `worktree: true`[\s\S]*otherwise give concurrent writers disjoint file ownership/is);
		assert.match(recipes, /worktree isolation when the tree is clean[\s\S]*otherwise/is);
		assert.match(prompting, /worktree isolation when the tree is clean[\s\S]*otherwise/is);
		assert.match(guidance, /unless the user has restricted work to a single writer per cwd/is);
		// The model-usable mechanism is `worktree: true` on workflow children;
		// single {agent, task} launches have no worktree field, so the parent
		// creates the worktree and passes it as cwd there.
		assert.match(skill, /worktree: true/);
		assert.match(lanes, /worktree: true/);
		assert.match(allGuidance, /no `worktree` field/);
		assert.doesNotMatch(allGuidance, /there is no model-passable worktree field/);
		// baseRef/isolation/model/thinking stay off workflow children.
		assert.doesNotMatch(execution, /`index`, `output`/);
		assert.match(execution, /no per-child output, outputMode, reads, progress, model, thinking/);
		assert.match(execution, /baseRef, isolation/);

		// Monolithic-task guideline: stage sequentially or fan out across seams.
		assert.match(skill, /do not\s+hand one subagent a monolithic task/is);
		assert.match(recipes, /serial milestones or parallel writers partitioned by file or contract ownership/is);

		assert.doesNotMatch(guidance, /parent works directly by default/i);
		assert.doesNotMatch(guidance, /operator-authorized|delegation is authorized|does not independently authorize delegation/i);
		assert.doesNotMatch(guidance, /one writer per|keep one writer|sole writer|one-writer/i);
		assert.doesNotMatch(allGuidance, /async:\s*(true|false)/);
		assert.doesNotMatch(allGuidance, /history-inheriting branch/i);

		assert.doesNotMatch(guidance, /not the routine primary doer/i);
		assert.doesNotMatch(guidance, /delegate[^\n]*(?:most|all) non-trivial requests/i);
		assert.doesNotMatch(guidance, /use this at the start of non-trivial work/i);
	});

	it("never presents output/outputMode/reads/progress as workflow child fields", () => {
		const execution = readProjectFile("skills/pi-subagents/references/execution-controls.md");

		// The workflow child allowlist is agent, task, cwd, resume, as, phase,
		// label, lane, index; output routing is agent-definition plus
		// tooling-managed artifacts, never per-child fields.
		assert.match(execution, /There are no per-child output, outputMode, reads, progress/is);
		assert.doesNotMatch(execution, /`index`, `output`/);
		assert.doesNotMatch(execution, /\boutput:\s*"(plans|worker|validation)\//);
		assert.doesNotMatch(execution, /outputMode:\s*"file-only"/);
	});
});
