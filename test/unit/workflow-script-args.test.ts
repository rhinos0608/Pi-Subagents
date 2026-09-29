import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizePublicSubagentExecution } from "../../src/extension/public-execution.ts";
import { runWorkflowScript } from "../../src/workflows/scripted-workflow.ts";

function missingPackageName(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	return message.match(/Cannot find package ['"]([^'"]+)['"]/i)?.[1];
}

let SubagentParams: Record<string, unknown> | undefined;
let schemasAvailable = true;
try {
	const schemas = (await import("../../src/extension/schemas.ts")) as Record<string, Record<string, unknown>>;
	SubagentParams = schemas.SubagentParams;
} catch (error) {
	if (missingPackageName(error) !== "typebox") throw error;
	schemasAvailable = false;
}

type Validator = {
	Check(value: unknown): boolean;
	Errors(value: unknown): Iterable<{ message: string }>;
};
let CompileSchema: ((schema: unknown) => Validator) | undefined;
try {
	const compileModule = (await import("typebox/compile")) as { Compile: typeof CompileSchema };
	CompileSchema = compileModule.Compile;
} catch (error) {
	if (missingPackageName(error) !== "typebox") throw error;
}

const describeIfSchemas = schemasAvailable && CompileSchema ? describe : describe.skip;

describeIfSchemas("workflowScript args: schema accepts plain-JSON args", () => {
	it("accepts workflowScript with args", () => {
		const validator = CompileSchema!(SubagentParams);
		assert.equal(validator.Check({ workflowScript: "return args.target;", args: { target: "src" } }), true);
	});

	it("args description names the frozen global and the secrets rule", () => {
		const properties = (SubagentParams as Record<string, Record<string, unknown>>)?.properties;
		const description = properties?.args?.description as string | undefined;
		assert.equal(typeof description, "string");
		assert.match(description!, /frozen global 'args'/);
		assert.match(description!, /run evidence/);
		assert.match(description!, /secret/i);
	});
});

describe("workflowScript args: public execution boundary", () => {
	const script = 'return await runs.run("one", { agent: "worker", task: "check" });';

	it("accepts args with workflowScript", () => {
		const result = normalizePublicSubagentExecution({ workflowScript: script, args: { target: "src" } });
		assert.equal(result.ok, true);
	});

	it("validate accepts args with workflowScript", () => {
		const result = normalizePublicSubagentExecution({ action: "validate", workflowScript: script, args: { target: "src" } });
		assert.equal(result.ok, true);
	});

	it("rejects args on agent/task launches", () => {
		const result = normalizePublicSubagentExecution({ agent: "worker", task: "do it", args: { target: "src" } });
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /args requires workflowScript/);
	});

	it("rejects args on management actions without workflowScript", () => {
		const result = normalizePublicSubagentExecution({ action: "steer", id: "abc123", message: "hi", args: { target: "src" } });
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /args requires workflowScript/);
	});

	it("rejects non-object args", () => {
		const result = normalizePublicSubagentExecution({ workflowScript: script, args: ["nope"] });
		assert.equal(result.ok, false);
	});

	it("rejects oversized args", () => {
		const result = normalizePublicSubagentExecution({ workflowScript: script, args: { blob: "x".repeat(17 * 1024) } });
		assert.equal(result.ok, false);
	});
});

describe("workflowScript args: sandbox global", () => {
	const launch = async (key: string) => ({ key, ok: true, output: "unused", artifactPaths: [] });
	const status = async (key: string) => ({ key, ok: true, output: "unused", artifactPaths: [] });

	it("exposes args readable in the script", async () => {
		const result = await runWorkflowScript({ script: `return args.target;`, args: { target: "src" }, launch, status });
		assert.equal(result.value, "src");
	});

	it("exposes args deeply frozen", async () => {
		const result = await runWorkflowScript({
			script: `return { root: Object.isFrozen(args), nested: Object.isFrozen(args.nested) };`,
			args: { nested: { target: "src" } },
			launch,
			status,
		});
		assert.deepEqual(result.value, { root: true, nested: true });
		await assert.rejects(
			runWorkflowScript({ script: `"use strict"; args.target = "mutated"; return args.target;`, args: { target: "src" }, launch, status }),
		);
	});
});
