import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSubagentGuide, SUBAGENT_GUIDE_TOPICS } from "../../src/extension/subagent-guide.ts";
import { SUBAGENT_ACTIONS } from "../../src/shared/types.ts";

describe("subagent guide", () => {
	it("reads the packaged overview by default", () => {
		const guide = readSubagentGuide();

		assert.match(guide, /# pi-subagents/);
	});

	it("lists valid topics for an unknown topic without changing files", () => {
		const guide = readSubagentGuide("unknown");

		assert.match(guide, /Unknown subagents guide topic 'unknown'/);
		assert.match(guide, /No files were changed\./);
		assert.match(guide, new RegExp(SUBAGENT_GUIDE_TOPICS.join(", ")));
	});

	it("registers the guide action for action recovery", () => {
		assert.ok(SUBAGENT_ACTIONS.includes("guide"));
	});

	it("serves the council protocol and its references without loaded skills", () => {
		const guide = readSubagentGuide("council");

		assert.match(guide, /# Council Mode/);
		assert.match(guide, /skills\/council-mode\/references\/pass-contracts\.md -->/);
		assert.match(guide, /skills\/pi-subagents\/references\/execution-controls\.md -->/);
		assert.match(guide, /External-job\/package advisors may join only when their provider is registered/);
		assert.match(guide, /use a fresh-context fallback when they cannot resume for cross-exam/);
		assert.doesNotMatch(guide, /External job profiles do not support[^.\n]*steer\/resume/);
	});

	it("documents external CLI runner limits in packaged guide topics", () => {
		assert.match(readSubagentGuide("agents"), /External CLI agents use their own runner contract[\s\S]*native Pi child options[\s\S]*model override[\s\S]*native Pi tools/);
		assert.match(readSubagentGuide("workflows"), /There are no per-child model, thinking, tool-budget/);
	});

	it("documents failed-lane recovery boundaries in packaged guide topics", () => {
		const workflows = readSubagentGuide("workflows");
		const agents = readSubagentGuide("agents");
		assert.match(workflows, /subagent workflow[\s\S]*child launch[\s\S]*prompt runtime[\s\S]*extension loading[\s\S]*child tooling setup[\s\S]*infrastructure blocker/);
		assert.match(workflows, /exact failure[\s\S]*run\/status[\s\S]*repository\/cwd/);
		assert.match(workflows, /same-protocol action/);
		assert.match(workflows, /External or foreground fallback requires explicit owner approval/);
		assert.match(agents, /exact failure\/run\/worktree state/);
		assert.match(agents, /clean[\s\S]*partial diff/);
		assert.match(agents, /external, foreground, or CLI runner requires explicit owner approval/);
	});

	it("keeps advanced workflow details in the packaged guide", () => {
		const guide = readSubagentGuide("workflows");

		assert.match(guide, /### Parallel sequential lanes[\s\S]*runs\.lanes/);
		assert.match(guide, /### Workflow steering[\s\S]*runs\.steer/);
		assert.match(guide, /For advanced rolling fanout[\s\S]*Promise\.race[\s\S]*Promise\.all/);
	});
});
