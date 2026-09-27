import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildResolvedRunPolicy, formatResolvedPolicySnapshotLines } from "../../src/policy/snapshot.ts";
import { formatEffectivePolicyLines, inspectSubagentFleet } from "../../src/runs/background/fleet-view.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";

describe("resolved policy snapshot", () => {
	it("builds a compact snapshot with exact fields, origins, and sources", () => {
		const snapshot = buildResolvedRunPolicy({
			model: "mock/test-model",
			modelOrigin: "configured",
			thinking: "high",
			thinkingOverride: undefined,
			agentThinking: "high",
			toolBudget: { soft: 10, hard: 20 },
			toolBudgetSource: "agent",
			timeoutMs: 60_000,
			timeoutSource: "call",
			worktree: true,
			allowedTools: ["read", "bash"],
			modelCandidates: ["mock/test-model", "mock/fallback"],
		});
		assert.deepEqual(snapshot, {
			version: 1,
			model: "mock/test-model",
			modelOrigin: "agent",
			thinking: "high",
			thinkingOrigin: "agent",
			toolBudgetSoft: 10,
			toolBudgetHard: 20,
			toolBudgetSource: "agent",
			timeoutMs: 60_000,
			timeoutSource: "call",
			context: "fresh",
			worktree: true,
			isolation: "process",
			allowedTools: ["read", "bash"],
			modelCandidates: ["mock/test-model", "mock/fallback"],
		});
	});

	it("maps explicit and inherited origins and drops unset optionals", () => {
		const snapshot = buildResolvedRunPolicy({
			modelOrigin: "explicit",
			thinkingOverride: "low",
			toolBudget: undefined,
			toolBudgetSource: "call",
			timeoutSource: "call",
		});
		assert.equal(snapshot.modelOrigin, "explicit");
		assert.equal(snapshot.thinkingOrigin, "explicit");
		assert.equal(snapshot.toolBudgetSource, "none");
		assert.equal(snapshot.timeoutSource, "none");
		assert.ok(!("model" in snapshot) && !("thinking" in snapshot) && !("toolBudgetHard" in snapshot) && !("timeoutMs" in snapshot) && !("allowedTools" in snapshot));
		const inherited = buildResolvedRunPolicy({ modelOrigin: "inherited", toolBudgetSource: "none", timeoutSource: "none" });
		assert.equal(inherited.modelOrigin, "operator");
		assert.equal(inherited.thinkingOrigin, "operator");
		const unattributed = buildResolvedRunPolicy({ modelOrigin: "default", toolBudgetSource: "none", timeoutSource: "none" });
		assert.equal(unattributed.modelOrigin, "default");
		assert.equal(unattributed.thinkingOrigin, "operator");
		assert.ok(!("model" in unattributed) && !("thinking" in unattributed));
	});

	it("persists a compact snapshot for workflow-parent launches", () => {
		// Mirrors the workflow-parent initial status write in subagent-executor.ts:
		// the parent inherits the caller model (or nothing), enforces no budget
		// or timeout of its own, and records its capability-ceiling tools.
		const parentModel = { provider: "mock", id: "test-model" };
		const withParent = buildResolvedRunPolicy({
			model: `${parentModel.provider}/${parentModel.id}`,
			modelOrigin: "inherited",
			toolBudgetSource: "none",
			timeoutSource: "none",
			worktree: false,
			allowedTools: ["read", "bash"],
		});
		assert.deepEqual(withParent, {
			version: 1,
			model: "mock/test-model",
			modelOrigin: "operator",
			thinkingOrigin: "operator",
			toolBudgetSource: "none",
			timeoutSource: "none",
			context: "fresh",
			worktree: false,
			isolation: "process",
			allowedTools: ["read", "bash"],
		});
		const unattributed = buildResolvedRunPolicy({
			model: undefined,
			modelOrigin: "default",
			toolBudgetSource: "none",
			timeoutSource: "none",
			worktree: false,
			allowedTools: undefined,
		});
		assert.deepEqual(unattributed, {
			version: 1,
			modelOrigin: "default",
			thinkingOrigin: "operator",
			toolBudgetSource: "none",
			timeoutSource: "none",
			context: "fresh",
			worktree: false,
			isolation: "process",
		});
		// Pin the write itself: the workflow-parent status literal must persist the snapshot.
		const source = fs.readFileSync(new URL("../../src/runs/foreground/subagent-executor.ts", import.meta.url), "utf-8");
		const statusAt = source.indexOf("workflowChildren: workflowChildSummary({ parentToolCallId");
		assert.ok(statusAt >= 0, "workflow-parent status literal exists");
		const statusHunk = source.slice(Math.max(0, statusAt - 1500), statusAt + 1500);
		assert.match(statusHunk, /policySnapshot: buildResolvedRunPolicy\(/);
	});
	it("renders snapshot fields through the effective-policy display", () => {
		const status = {
			runId: "policy-render",
			mode: "single",
			state: "running",
			startedAt: 1,
			steps: [{ agent: "worker", status: "running" }],
			timeoutMs: 5_000,
			toolBudget: { soft: 1, hard: 2, toolCount: 0, outcome: "within-budget" },
			capabilityCeiling: { allowedTools: ["read"], sources: ["test"] },
			launchContractDigest: "digest-guess",
			policySnapshot: buildResolvedRunPolicy({
				model: "mock/test-model",
				modelOrigin: "configured",
				toolBudget: { hard: 2 },
				toolBudgetSource: "call",
				timeoutMs: 5_000,
				timeoutSource: "call",
				allowedTools: ["read"],
			}),
		} as unknown as AsyncStatus;
		const lines = formatEffectivePolicyLines(status);
		assert.equal(lines[0], "Effective policy (launch snapshot):");
		assert.ok(lines.some((line) => line.includes("mock/test-model") && line.includes("(agent)")), lines.join("\n"));
		assert.ok(lines.some((line) => line.includes("hard 2") && line.includes("[call]")), lines.join("\n"));
		assert.ok(lines.some((line) => line.includes("5000ms") && line.includes("[call]")), lines.join("\n"));
		assert.ok(!lines.some((line) => line.includes("digest-guess")), "snapshot replaces fragment-guessing");
	});

	it("falls back to reachable fragments without a snapshot", () => {
		const lines = formatEffectivePolicyLines({ runId: "no-snapshot", mode: "single", state: "running", startedAt: 1, steps: [] } as unknown as AsyncStatus);
		assert.equal(lines[0], "Effective policy (reachable fragments; no persisted policy snapshot):");
	});

	it("renders one compact policy line per fleet run", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-policy-fleet-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-policy");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-policy",
				mode: "single",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [{ agent: "worker", status: "running", startedAt: 100 }],
				policySnapshot: buildResolvedRunPolicy({
					model: "mock/test-model",
					modelOrigin: "configured",
					toolBudget: { hard: 20 },
					toolBudgetSource: "agent",
					timeoutMs: 60_000,
					timeoutSource: "call",
					allowedTools: ["read", "bash"],
				}),
			}));
			updateActiveRunIndex(asyncDir, "running");
			const result = inspectSubagentFleet({}, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 250,
			});
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			assert.match(text, /policy: mock\/test-model \(agent\) · budget 20 \[agent\] · timeout 60000ms \[call\] · 2 tools/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("formats every snapshot line without live turn counts", () => {
		const lines = formatResolvedPolicySnapshotLines(buildResolvedRunPolicy({ toolBudgetSource: "none", timeoutSource: "none" }));
		assert.ok(lines.length >= 6 && lines.length <= 8, lines.join("\n"));
		assert.doesNotMatch(lines.join("\n"), /turns|tools used/i);
	});
});
