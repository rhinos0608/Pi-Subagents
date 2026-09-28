import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { installAsyncExecutionHooks, available, createSubagentExecutor, mockPi, tempDir, createRepo, readAsyncPayload, ASYNC_DIR } from "../support/async-execution-fixture.ts";

function makeAdmissionExecutor(config: Record<string, unknown> = {}) {
	return createSubagentExecutor!({
		pi: { events: createEventBus(), getSessionName: () => undefined, sendMessage() {} },
		state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
		config,
		asyncByDefault: false,
		tempArtifactsDir: tempDir,
		getSubagentSessionRoot: () => tempDir,
		expandTilde: (p: string) => p,
		discoverAgents: () => ({ agents: [makeAgent("worker")] }),
	});
}


function callCount(): number {
	return fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-") && name.endsWith(".json")).length;
}

describe("public workflow worktree admission", { skip: !available }, () => {
	installAsyncExecutionHooks();
	it("rejects a direct async worktree launch before returning a receipt", async () => {
		// Rewritten: public `async` left the model vocabulary (Phase 6a), so the
		// direct-async receipt gate is proven at the operator/internal launch path
		// that still enforces it (subagent-executor single worktree preflight).
		const repo = createRepo("pi-direct-admission-dirty-");
		fs.writeFileSync(path.join(repo, "untracked.txt"), "dirty");
		const asyncDirExistedBefore = fs.existsSync(ASYNC_DIR);
		const asyncEntriesBefore = new Set(asyncDirExistedBefore ? fs.readdirSync(ASYNC_DIR) : []);
		try {
			const executor = makeAdmissionExecutor();
			const result = await (executor as unknown as { execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: unknown) => Promise<{ content: Array<{ text?: string }>; isError?: boolean; details?: { asyncId?: string } }> }).execute("direct-admission-dirty", {
				agent: "worker", task: "Inspect", async: true, worktree: true, cwd: repo,
			}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));

			assert.equal(result.isError, true);
			assert.match(result.content.map((item) => item.text).join("\n"), /worktree isolation requires a clean git working tree\. Commit or stash changes first\./);
			assert.equal(result.details?.asyncId, undefined);
			assert.equal(callCount(), 0);
			assert.equal(fs.existsSync(ASYNC_DIR), asyncDirExistedBefore);
			assert.deepEqual(new Set(asyncDirExistedBefore ? fs.readdirSync(ASYNC_DIR) : []), asyncEntriesBefore);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
	for (const async of [false, true]) {
		for (const source of ["nonrepo", "dirty"] as const) {
			// QUARANTINED (async=true): top-level public `async` was removed from the
			// model vocabulary (Phase 6a, commit 25542469); the live gate for this
			// pair is kept by the async=false variant rewritten below to
			// { isolation: "worktree", workflowScript }. Do not revive.
			const quarantined = async === true;
			(quarantined ? it.skip : it)(`rejects a mixed ${source} group before child dispatch or budget claims (async=${async})`, async () => {
				const repo = createRepo("pi-admission-valid-");
				const invalid = source === "dirty" ? createRepo("pi-admission-dirty-") : tempDir;
				if (source === "dirty") fs.writeFileSync(path.join(invalid, "untracked.txt"), "dirty");
				try {
					// Rewritten: per-child `async`/`worktree`/`output` left the workflow
					// child allowlist (Phase 6b, db1422f3); admission is driven by the
					// top-level isolation flag plus per-child cwd only. Public
					// workflows always detach, so enforcement surfaces in the
					// background payload/status, not inline.
					const executor = makeAdmissionExecutor();
					const script = `const results = await runs.all([${JSON.stringify(repo)}, ${JSON.stringify(invalid)}].map((cwd, i) => ({ key: 'child-' + i, agent: 'worker', task: 'Inspect', cwd }))); if (results.some(r => !r.ok)) throw new Error(results.map(r => r.error).join('; ')); return results;`;
					const result = await executor.executePublic(`admission-${source}-${async}`, { workflowScript: script, isolation: "worktree", maxSubagentSpawnsPerRun: 2 }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
					assert.ok(result.details?.asyncId);
					const payload = await readAsyncPayload(result.details.asyncId);
					assert.equal(payload.success, false);
					assert.match(payload.error ?? "", /Worktree admission failed.*child-1/);
					const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, result.details.asyncId, "status.json"), "utf8"));
					const budget = status.runFanoutBudget;
					assert.deepEqual(budget, { used: 0, limit: 2, remaining: 2 });
					assert.ok(status.steps.every((step: { runId?: string }) => !step.runId));
					assert.equal(callCount(), 0);
				} finally {
					fs.rmSync(repo, { recursive: true, force: true });
					if (invalid !== tempDir) fs.rmSync(invalid, { recursive: true, force: true });
				}
			});
		}
	}
	it("launches a valid isolated child and preserves explicit false on a non-repository sibling", async () => {
		// Rewritten: per-child `async`/`worktree` left the workflow child allowlist
		// (Phase 6b, db1422f3), so per-child worktree opt-out no longer exists;
		// isolation is top-level only. Prove the live path: two clean-repo children
		// under top-level isolation both dispatch into managed worktrees.
		const repo = createRepo("pi-admission-clean-");
		const siblingRepo = createRepo("pi-admission-clean-sibling-");
		mockPi.onCall({ output: "Inspected" });
		mockPi.onCall({ output: "Shared cwd inspected" });
		try {
			const executor = makeAdmissionExecutor({ worktreeProvider: "native" });
			const result = await executor.executePublic("admission-clean", {
				workflowScript: `const results = await runs.all([{ key: 'isolated', agent: 'worker', task: 'Inspect', cwd: ${JSON.stringify(repo)} }, { key: 'shared', agent: 'worker', task: 'Inspect shared', cwd: ${JSON.stringify(siblingRepo)} }]); return results.map(r => r.ok);`,
				isolation: "worktree",
			}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, undefined, JSON.stringify(result));
			assert.ok(result.details?.asyncId, "public workflow launch detaches async");
			const payload = await readAsyncPayload(result.details.asyncId);
			assert.equal(payload.success, true, JSON.stringify(payload.error ?? payload));
			assert.equal(callCount(), 2);
			assert.deepEqual((payload as { workflow?: { value?: unknown } }).workflow?.value ?? (result.details as { workflow?: { value?: unknown } }).workflow?.value, [true, true]);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(siblingRepo, { recursive: true, force: true });
		}
	});
});
