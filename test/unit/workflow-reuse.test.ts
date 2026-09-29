import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	matchWorkflowReuse,
	workflowChildFingerprint,
	type WorkflowReuseSource,
} from "../../src/workflows/workflow-reuse.ts";
import type { WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-reuse-"));
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function touch(...segments: string[]): string {
	const file = path.join(tempDir, ...segments);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "evidence", "utf-8");
	return file;
}

function settledResult(overrides: Partial<WorkflowScriptChildResult> = {}): WorkflowScriptChildResult {
	return {
		key: "stage1",
		ok: true,
		output: "stage one done",
		artifactPaths: [],
		...overrides,
	};
}

function sourceWithSettled(key: string, fingerprint: string, result: WorkflowScriptChildResult): WorkflowReuseSource {
	return {
		runId: "prior-run",
		started: new Map(),
		settled: new Map([[key, { fingerprint, result }]]),
	};
}

describe("matchWorkflowReuse worktree guard", () => {
	it("reuses a settled worktree child while every referenced artifact still exists", () => {
		const worktreeDir = path.join(tempDir, "worktrees", "stage1");
		fs.mkdirSync(worktreeDir, { recursive: true });
		const handoff = touch("artifacts", "handoff.json");
		const patch = touch("artifacts", "stage1.patch");
		const output = touch("artifacts", "output.txt");
		const params = { agent: "worker", task: "do work", worktree: true };
		const fingerprint = workflowChildFingerprint(params);
		const source = sourceWithSettled(
			"stage1",
			fingerprint,
			settledResult({
				artifactPaths: [worktreeDir, handoff, patch],
				outputArtifactPath: handoff,
				outputPathMapping: { requestedPath: path.join(worktreeDir, "out.txt"), savedPath: output },
			}),
		);

		const match = matchWorkflowReuse(source, "stage1", fingerprint);

		assert.equal(match?.kind, "settled");
	});

	it("re-runs instead of reusing once cleanup removed the worktree or an artifact", () => {
		const worktreeDir = path.join(tempDir, "worktrees", "stage1");
		fs.mkdirSync(worktreeDir, { recursive: true });
		const handoff = touch("artifacts", "handoff.json");
		const params = { agent: "worker", task: "do work", worktree: true };
		const fingerprint = workflowChildFingerprint(params);
		const result = settledResult({ artifactPaths: [worktreeDir, handoff], outputArtifactPath: handoff });

		assert.equal(matchWorkflowReuse(sourceWithSettled("stage1", fingerprint, result), "stage1", fingerprint)?.kind, "settled");

		// Stop cleanup removes the managed worktree directory after capturing the handoff patch.
		fs.rmSync(worktreeDir, { recursive: true, force: true });
		assert.equal(matchWorkflowReuse(sourceWithSettled("stage1", fingerprint, result), "stage1", fingerprint), undefined);

		// A pruned handoff artifact also forces a re-run.
		fs.mkdirSync(worktreeDir, { recursive: true });
		fs.rmSync(handoff, { force: true });
		assert.equal(matchWorkflowReuse(sourceWithSettled("stage1", fingerprint, result), "stage1", fingerprint), undefined);
	});

	it("fingerprints worktree:true children apart from worktree:false ones", () => {
		const base = { agent: "worker", task: "do work" };
		const withWorktree = workflowChildFingerprint({ ...base, worktree: true });
		const withoutWorktree = workflowChildFingerprint({ ...base, worktree: false });
		const omitted = workflowChildFingerprint(base);
		assert.notEqual(withWorktree, withoutWorktree);
		assert.notEqual(withWorktree, omitted);
		assert.notEqual(withoutWorktree, omitted);

		// A settled worktree:true child never matches a worktree:false relaunch.
		const handoff = touch("artifacts", "handoff.json");
		const source = sourceWithSettled("stage1", withWorktree, settledResult({ artifactPaths: [handoff] }));
		assert.equal(matchWorkflowReuse(source, "stage1", withoutWorktree), undefined);
	});
});
