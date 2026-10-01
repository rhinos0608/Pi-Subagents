import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	runWorkflowScript,
	validateWorkflowScript,
	workflowRunParamsFingerprint,
	WorkflowScriptError,
	type WorkflowScriptChildResult,
} from "../../src/workflows/scripted-workflow.ts";
import { resolveEffectiveOutputSchema } from "../../src/runs/shared/child-launch-plan.ts";
import { validateStructuredOutputValue } from "../../src/runs/shared/structured-output.ts";

// FORK(FD-010): per-child outputSchema override on runs.run/runs.all/lane children only.

function staticResult(paramsSource: string): { ok: boolean; messages: string } {
	const result = validateWorkflowScript(`return await runs.run("one", ${paramsSource});`);
	return { ok: result.ok, messages: result.errors.map((error) => error.message).join("; ") };
}

function launchStub(seen: Array<{ key: string; params: Record<string, unknown> }>, behavior?: (key: string, params: Record<string, unknown>) => WorkflowScriptChildResult) {
	return {
		async launch(key: string, params: Record<string, unknown>): Promise<WorkflowScriptChildResult> {
			seen.push({ key, params });
			if (behavior) return behavior(key, params);
			return { key, ok: true, output: key, artifactPaths: [] };
		},
		async status(key: string): Promise<WorkflowScriptChildResult> {
			return { key, ok: true, output: "ok", artifactPaths: [] };
		},
	};
}

describe("workflow child outputSchema (FD-010)", () => {
	it("static: accepts an object-root schema literal", () => {
		const result = staticResult(`{ agent: "worker", task: "check", outputSchema: { type: "object", properties: { ok: { type: "boolean" } } } }`);
		assert.equal(result.ok, true, result.messages);
	});

	it("static: accepts false to disable the agent default", () => {
		const result = staticResult(`{ agent: "worker", task: "check", outputSchema: false }`);
		assert.equal(result.ok, true, result.messages);
	});

	for (const [name, params] of [
		["string", `{ agent: "worker", task: "check", outputSchema: "schema" }`],
		["array", `{ agent: "worker", task: "check", outputSchema: [] }`],
		["non-object root", `{ agent: "worker", task: "check", outputSchema: { type: "string" } }`],
		["true", `{ agent: "worker", task: "check", outputSchema: true }`],
	] as const) {
		it(`static: rejects ${name} naming the field`, () => {
			const result = staticResult(params);
			assert.equal(result.ok, false, `${name} should fail static validation`);
			assert.match(result.messages, /outputSchema/);
		});
	}

	it("runtime: rejects a non-object-root schema before launch", async () => {
		const seen: Array<{ key: string; params: Record<string, unknown> }> = [];
		await assert.rejects(
			runWorkflowScript({
				script: `const bad = "schema";\nreturn await runs.run("one", { agent: "worker", task: "check", outputSchema: bad });`,
				timeoutMs: 5_000,
				...launchStub(seen),
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /outputSchema/.test(error.message),
		);
		assert.deepEqual(seen, []);
	});

	it("runtime: rejects an oversized schema before launch", async () => {
		const seen: Array<{ key: string; params: Record<string, unknown> }> = [];
		await assert.rejects(
			runWorkflowScript({
				script: `return await runs.run("one", { agent: "worker", task: "check", outputSchema: { type: "object", properties: { blob: { type: "string", maxLength: 1 }, pad: ${JSON.stringify("x".repeat(5000))} } } });`,
				timeoutMs: 5_000,
				...launchStub(seen),
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /outputSchema exceeds 4096 bytes/.test(error.message),
		);
		assert.deepEqual(seen, []);
	});

	it("runtime: threads the override and false into launch params", async () => {
		const seen: Array<{ key: string; params: Record<string, unknown> }> = [];
		const schema = { type: "object", properties: { ok: { type: "boolean" } } };
		await runWorkflowScript({
			script: `const a = await runs.run("a", { agent: "worker", task: "check", outputSchema: ${JSON.stringify(schema)} });\nconst b = await runs.run("b", { agent: "worker", task: "check", outputSchema: false });\nreturn [a.ok, b.ok];`,
			timeoutMs: 5_000,
			...launchStub(seen),
		});
		assert.deepEqual(seen.find((entry) => entry.key === "a")?.params.outputSchema, schema);
		assert.equal(seen.find((entry) => entry.key === "b")?.params.outputSchema, false);
	});

	it("false disables the agent-frontmatter default", () => {
		const agent = { name: "typed", outputSchema: { type: "object" } } as unknown as Parameters<typeof resolveEffectiveOutputSchema>[0];
		assert.deepEqual(resolveEffectiveOutputSchema(agent, { type: "object", required: ["ok"] } as never), { type: "object", required: ["ok"] });
		assert.equal(resolveEffectiveOutputSchema(agent, false), undefined);
		assert.deepEqual(resolveEffectiveOutputSchema(agent, undefined), { type: "object" });
	});

	it("schema mismatch fails the child carrying the schema message while siblings continue", async () => {
		const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
		const seen: Array<{ key: string; params: Record<string, unknown> }> = [];
		const result = await runWorkflowScript({
			script: `return await runs.all([{ key: "bad", agent: "worker", task: "bad", outputSchema: ${JSON.stringify(schema)} }, { key: "good", agent: "worker", task: "good" }]);`,
			timeoutMs: 5_000,
			...launchStub(seen, (key) => {
				if (key === "good") return { key, ok: true, output: "fine", artifactPaths: [] };
				return { key, ok: false, output: "", error: "Structured output validation failed: ok: is required", artifactPaths: [] };
			}),
		});
		const badValidation = await validateStructuredOutputValue(schema as never, { nope: 1 });
		assert.equal(badValidation.status, "invalid");
		const value = result.value as Array<{ key: string; ok: boolean; error?: string }>;
		assert.equal(value.length, 2);
		assert.equal(value[0]?.key, "bad");
		assert.equal(value[0]?.ok, false);
		assert.match(value[0]?.error ?? "", /ok: is required/);
		assert.equal(value[1]?.ok, true);
		assert.deepEqual(seen.find((entry) => entry.key === "bad")?.params.outputSchema, schema);
	});

	it("fingerprint distinguishes outputSchema present from absent", () => {
		const base = { agent: "worker", task: "check" };
		const withSchema = { ...base, outputSchema: { type: "object" } };
		assert.notEqual(workflowRunParamsFingerprint(base), workflowRunParamsFingerprint(withSchema));
		assert.notEqual(workflowRunParamsFingerprint(base), workflowRunParamsFingerprint({ ...base, outputSchema: false }));
	});

	it("top-level model tool stays 9 fields: outputSchema rejected there", async () => {
		let schemasAvailable = true;
		let SubagentParams: Record<string, unknown> | undefined;
		try {
			SubagentParams = ((await import("../../src/extension/schemas.ts")) as Record<string, unknown>).SubagentParams as Record<string, unknown>;
		} catch (error) {
		if (!(error instanceof Error) || !/Cannot find package ["']typebox["']/i.test(error.message)) throw error;
		schemasAvailable = false;
		}
		if (!schemasAvailable || !SubagentParams) return;
		const { Compile } = (await import("typebox/compile")) as unknown as { Compile: (schema: unknown) => { Check(value: unknown): boolean } };
		const validator = Compile(SubagentParams);
		assert.equal(validator.Check({ agent: "worker", task: "check" }), true);
		assert.equal(validator.Check({ agent: "worker", task: "check", outputSchema: false }), false);
		assert.equal(validator.Check({ agent: "worker", task: "check", outputSchema: { type: "object" } }), false);
		assert.deepEqual(Object.keys((SubagentParams.properties ?? {}) as Record<string, unknown>).sort(), ["action", "agent", "args", "cwd", "id", "message", "task", "topic", "workflowScript"]);
	});

	it("identical params share a fingerprint, so settled reuse keys stay stable", () => {
		const base = { agent: "worker", task: "check" };
		assert.equal(workflowRunParamsFingerprint(base), workflowRunParamsFingerprint({ agent: "worker", task: "check" }));
		const withSchema = { ...base, outputSchema: { type: "object" } };
		assert.equal(workflowRunParamsFingerprint(withSchema), workflowRunParamsFingerprint({ ...base, outputSchema: { type: "object" } }));
	});
});
