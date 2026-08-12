import assert from "node:assert/strict";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import {
	claimRunFanoutBatch,
	createRunFanoutBudget,
	decodeRunFanoutBudgetDescriptor,
	encodeRunFanoutBudgetDescriptor,
	getRunFanoutBudgetSnapshot,
	RunFanoutLimitError,
	validateRunFanoutBudgetDescriptor,
} from "../../src/runs/shared/run-fanout-budget.ts";
import { resolveMaxSubagentSpawnsPerRun } from "../../src/shared/types.ts";

const directories: string[] = [];
const previousEnv = process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN;

afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
	if (previousEnv === undefined) delete process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN;
	else process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN = previousEnv;
});

function budget(limit: number) {
	const descriptor = createRunFanoutBudget(`test-${Date.now()}-${Math.random()}`, limit);
	directories.push(descriptor.directory);
	return descriptor;
}

describe("run fan-out budget", () => {
	it("resolves environment over config and falls back to 64", () => {
		delete process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN;
		assert.equal(resolveMaxSubagentSpawnsPerRun(undefined), 64);
		assert.equal(resolveMaxSubagentSpawnsPerRun(12), 12);
		for (const invalid of [0, -1, 1.5, "bad"]) assert.equal(resolveMaxSubagentSpawnsPerRun(invalid as number), 64);
		process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN = "7";
		assert.equal(resolveMaxSubagentSpawnsPerRun(12), 7);
		for (const invalid of ["0", "-1", "1.5", "bad"]) {
			process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN = invalid;
			assert.equal(resolveMaxSubagentSpawnsPerRun(undefined), 64);
		}
	});

	it("persists claims and rejects the responsible next path at the exact cap", () => {
		const descriptor = budget(2);
		assert.deepEqual(claimRunFanoutBatch(descriptor, ["tasks[0]", "tasks[1]"]), { used: 2, limit: 2, remaining: 0 });
		const restored = decodeRunFanoutBudgetDescriptor(encodeRunFanoutBudgetDescriptor(descriptor));
		assert.deepEqual(getRunFanoutBudgetSnapshot(restored!), { used: 2, limit: 2, remaining: 0 });
		assert.throws(() => claimRunFanoutBatch(descriptor, ["tasks[2]"]), (error: unknown) => {
			assert.ok(error instanceof RunFanoutLimitError);
			assert.equal(error.rejection.path, "tasks[2]");
			assert.equal(error.rejection.used, 2);
			assert.equal(error.rejection.remaining, 0);
			return true;
		});
	});

	it("rolls back only the failed admission batch", () => {
		const descriptor = budget(2);
		claimRunFanoutBatch(descriptor, ["single"]);
		assert.throws(() => claimRunFanoutBatch(descriptor, ["chain[0]", "chain[1]"]), RunFanoutLimitError);
		assert.deepEqual(getRunFanoutBudgetSnapshot(descriptor), { used: 1, limit: 2, remaining: 1 });
	});

	it("admits exactly one simultaneous process for the last slot", async () => {
		const descriptor = budget(1);
		const modulePath = fileURLToPath(new URL("../../src/runs/shared/run-fanout-budget.ts", import.meta.url));
		const script = `import { claimRunFanoutBatch } from ${JSON.stringify(modulePath)}; const descriptor = JSON.parse(process.argv[1]); try { claimRunFanoutBatch(descriptor, [process.argv[2]]); process.stdout.write("admitted"); } catch { process.stdout.write("rejected"); }`;
		const launch = (claimPath: string) => new Promise<string>((resolve, reject) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script, JSON.stringify(descriptor), claimPath], { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => { stdout += chunk; });
			child.stderr.on("data", (chunk) => { stderr += chunk; });
			child.on("error", reject);
			child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
		});

		assert.deepEqual((await Promise.all([launch("nested[a]"), launch("nested[b]")])).sort(), ["admitted", "rejected"]);
		assert.deepEqual(getRunFanoutBudgetSnapshot(descriptor), { used: 1, limit: 1, remaining: 0 });
	});

	it("fails closed when descriptor identity does not match the manifest", () => {
		const descriptor = budget(2);
		assert.throws(() => validateRunFanoutBudgetDescriptor({ ...descriptor, limit: 3 }), /does not match/);
	});
});
