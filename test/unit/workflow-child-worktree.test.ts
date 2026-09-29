import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { preflightWorkflowWorktrees } from "../../src/runs/foreground/subagent-executor.ts";
import { runWorkflowScript, validateWorkflowScript, WorkflowScriptError } from "../../src/workflows/scripted-workflow.ts";

function staticMessages(script: string): { ok: boolean; messages: string } {
	const result = validateWorkflowScript(script);
	return { ok: result.ok, messages: result.errors.map((error) => error.message).join("; ") };
}

function initGitRepo(dirty: boolean): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-worktree-"));
	const git = (...args: string[]): void => {
		execFileSync("git", args, { cwd: root, stdio: "ignore" });
	};
	git("init");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	fs.writeFileSync(path.join(root, "file.txt"), "base\n", "utf-8");
	git("add", "file.txt");
	git("commit", "-m", "base");
	if (dirty) fs.writeFileSync(path.join(root, "file.txt"), "dirty\n", "utf-8");
	return root;
}

describe("workflow child worktree isolation", () => {
	it("static validation accepts worktree:true on runs.run, runs.all items, and runs.lanes stages", () => {
		for (const script of [
			`return await runs.run("one", { agent: "worker", task: "check", worktree: true });`,
			`return await runs.all([{ key: "one", agent: "worker", task: "check", worktree: true }]);`,
			`return await runs.lanes([{ key: "lane", stages: [{ key: "build", agent: "worker", task: "check", worktree: true }] }]);`,
		]) {
			const result = staticMessages(script);
			assert.equal(result.ok, true, `${script} should validate statically (${result.messages})`);
		}
	});

	it("static validation still rejects baseRef, isolation, and provider on children", () => {
		for (const field of [`baseRef: "HEAD"`, `isolation: "worktree"`, `provider: "auto"`]) {
			const result = staticMessages(`return await runs.run("one", { agent: "worker", task: "check", ${field} });`);
			assert.equal(result.ok, false, `${field} should fail static validation (${result.messages})`);
			assert.match(result.messages, /unsupported field/);
		}
	});

	it("worktree:true reaches launch as worktree:true", async () => {
		const seen: Array<{ key: string; params: Record<string, unknown> }> = [];
		const result = await runWorkflowScript({
			script: `return await runs.run("one", { agent: "worker", task: "check", worktree: true });`,
			timeoutMs: 5_000,
			async launch(key, params) {
				seen.push({ key, params });
				return { key, ok: true, output: "done", artifactPaths: [], results: [] };
			},
			async status(key) {
				return { key, ok: true, output: "ok", artifactPaths: [] };
			},
		});
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.params.worktree, true);
		assert.equal(result.value.ok, true);
	});

	it('worktree:"yes" is rejected before launch with a clear message', async () => {
		const launches: string[] = [];
		await assert.rejects(
			runWorkflowScript({
				script: `return await runs.run("one", { agent: "worker", task: "check", worktree: "yes" });`,
				timeoutMs: 5_000,
				async launch(key) {
					launches.push(key);
					return { key, ok: true, output: key, artifactPaths: [], results: [] };
				},
				async status(key) {
					return { key, ok: true, output: "ok", artifactPaths: [] };
				},
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /worktree must be a boolean/.test(error.message),
		);
		assert.deepEqual(launches, []);
	});

	it("baseRef on a child is rejected before launch", async () => {
		const launches: string[] = [];
		await assert.rejects(
			runWorkflowScript({
				script: `return await runs.run("one", { agent: "worker", task: "check", baseRef: "HEAD" });`,
				timeoutMs: 5_000,
				async launch(key) {
					launches.push(key);
					return { key, ok: true, output: key, artifactPaths: [], results: [] };
				},
				async status(key) {
					return { key, ok: true, output: "ok", artifactPaths: [] };
				},
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /unsupported field.*baseRef/.test(error.message),
		);
		assert.deepEqual(launches, []);
	});

	it("worktree admission refuses a dirty tree and accepts a clean tree", async () => {
		const dirtyRoot = initGitRepo(true);
		const cleanRoot = initGitRepo(false);
		try {
			const calls = [{ key: "one", params: { agent: "worker", task: "check", worktree: true } as Record<string, unknown> }];
			await assert.rejects(
				preflightWorkflowWorktrees({
					workflowDefaults: {},
					calls,
					ctxCwd: dirtyRoot,
					signal: new AbortController().signal,
				}),
				/clean git working tree/,
			);
			await preflightWorkflowWorktrees({
				workflowDefaults: {},
				calls,
				ctxCwd: cleanRoot,
				signal: new AbortController().signal,
			});
		} finally {
			fs.rmSync(dirtyRoot, { recursive: true, force: true });
			fs.rmSync(cleanRoot, { recursive: true, force: true });
		}
	});
});
