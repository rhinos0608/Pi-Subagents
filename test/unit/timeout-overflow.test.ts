import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgents } from "../../src/agents/agents.ts";
import { timerDelayOverflowError } from "../../src/runs/foreground/subagent-executor.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function writeAgent(filePath: string, body: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

describe("oversized run timeout guard (upstream 5655f9bb, fork-adapted)", () => {
	it("rejects values above the maximum schedulable timer delay", () => {
		assert.equal(
			timerDelayOverflowError("timeoutMs", 2_147_483_648),
			"timeoutMs must be a positive integer no larger than 2147483647.",
		);
		assert.equal(timerDelayOverflowError("timeoutMs", 2_147_483_647), undefined);
		assert.equal(timerDelayOverflowError("config.timeoutMs", 2_147_483_648), "config.timeoutMs must be a positive integer no larger than 2147483647.");
		assert.equal(timerDelayOverflowError("timeoutMs", undefined), undefined);
		assert.equal(timerDelayOverflowError("timeoutMs", "huge"), undefined);
	});

	it("rejects oversized agent timeoutMs frontmatter at discovery", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-timeout-overflow-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, ".pi", "agents", "worker.md");
		writeAgent(filePath, `---
name: worker
description: Worker
timeoutMs: 2147483648
---

Do work
`);
		assert.match(discoverAgents(dir, "project").agentDiagnostics?.[0]?.error ?? "", /Agent 'worker' has invalid timeoutMs frontmatter; expected a positive integer no larger than 2147483647/);

		writeAgent(filePath, `---
name: worker
description: Worker
timeoutMs: 2147483647
---

Do work
`);
		assert.equal(
			discoverAgents(dir, "project").agents.find((agent) => agent.name === "worker")?.defaultTimeoutMs,
			2_147_483_647,
		);
	});
});
