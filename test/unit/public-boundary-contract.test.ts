import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveSubagentRunId } from "../../src/runs/background/run-id-resolver.ts";
import { createSubagentExecutor, rejectMissingControlRunId, unknownSubagentActionMessage } from "../../src/runs/foreground/subagent-executor.ts";
import { MODEL_VISIBLE_SUBAGENT_ACTIONS, SUBAGENT_ACTIONS } from "../../src/shared/types.ts";

// Phase 1b public-boundary contract tests: prove the INTENDED end state from
// docs/subagent-tooling-overhaul.md ("Target public tool boundary" + "Schema cleanup").
//
// Intended top-level vocabulary (8 fields only):
//   agent, task, cwd, workflowScript, action, id, message, topic (guide-only)
// Plus the intended runs.run child allowlist: { agent, task, cwd, resume }.
//
// Sibling-work note: three sibling worktrees are concurrently shrinking the
// actual schemas (collapsing workflowScriptPath/workflow/args into
// workflowScript-only, removing management-action branches, hardening
// runs.run). Assertions that depend on their not-yet-merged work are marked
// `// Phase 6 siblings in flight` and are EXPECTED to fail until that lands.

type JsonSchemaNode = Record<string, unknown>;

function missingPackageName(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	return message.match(/Cannot find package ['"]([^'"]+)['"]/i)?.[1];
}

let SubagentParams: JsonSchemaNode | undefined;
let schemasAvailable = true;
try {
	const schemas = (await import("../../src/extension/schemas.ts")) as Record<string, JsonSchemaNode>;
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

let validateWorkflowScript:
	| ((script: string, options?: Record<string, unknown>) => { ok: boolean; errors: Array<{ message: string }> })
	| undefined;
try {
	const workflow = (await import("../../src/workflows/scripted-workflow.ts")) as Record<string, unknown>;
	validateWorkflowScript = workflow.validateWorkflowScript as typeof validateWorkflowScript;
} catch {
	validateWorkflowScript = undefined;
}

const describeIfSchemas = schemasAvailable && CompileSchema ? describe : describe.skip;

describeIfSchemas("public boundary: intended 8-field shapes validate", () => {
	function check(value: unknown): boolean {
		return CompileSchema!(SubagentParams).Check(value);
	}

	it("launch shape validates", () => {
		assert.equal(check({ agent: "worker", task: "Fix the bug" }), true);
	});

	it("launch shape with cwd validates", () => {
		assert.equal(check({ agent: "worker", task: "Fix the bug", cwd: "/repo/pkg" }), true);
	});

	it("workflow shape validates", () => {
		assert.equal(
			check({ workflowScript: 'return await runs.run("one", { agent: "worker", task: "check" })' }),
			true,
		);
	});

	it("workflow shape with cwd validates", () => {
		assert.equal(
			check({
				workflowScript: 'return await runs.run("one", { agent: "worker", task: "check" })',
				cwd: "/repo",
			}),
			true,
		);
	});

	for (const action of ["steer", "resume", "interrupt"]) {
		it(`control shape validates: action=${action}`, () => {
			assert.equal(check({ action, id: "run-abc123", message: "adjust course" }), true);
		});
	}

	it("guide shape with topic validates", () => {
		assert.equal(check({ action: "guide", topic: "agents" }), true);
	});

	it("guide shape without topic validates", () => {
		assert.equal(check({ action: "guide" }), true);
	});

	it("topic description survives top-level pruning (guide-only)", () => {
		const properties = (SubagentParams as JsonSchemaNode)?.properties as Record<string, JsonSchemaNode> | undefined;
		const topic = properties?.topic as JsonSchemaNode | undefined;
		assert.equal(typeof topic?.description, "string");
		assert.match(topic?.description as string, /guide/i);
	});
});

describeIfSchemas("public boundary: legacy workflow spellings are rejected", () => {
	function check(value: unknown): { ok: boolean; detail: string } {
		const validator = CompileSchema!(SubagentParams);
		const ok = validator.Check(value);
		const detail = [...validator.Errors(value)].map((error) => error.message).join(", ");
		return { ok, detail };
	}

	// Phase 6 siblings in flight: siblings are collapsing
	// workflowScriptPath/workflow/args into workflowScript-only.
	it("workflowScriptPath is rejected", () => {
		const result = check({ workflowScriptPath: "workflows/review.js" });
		assert.equal(result.ok, false, `workflowScriptPath should not validate (${result.detail})`);
	});

	// Phase 6 siblings in flight: named-workflow `workflow` + `args` spelling collapses away.
	it("named workflow + args spelling is rejected", () => {
		const result = check({ workflow: "review", args: { target: "src" } });
		assert.equal(result.ok, false, `workflow/args should not validate (${result.detail})`);
	});
});

describeIfSchemas("public boundary: old management/tuning fields fail validation", () => {
	function check(value: unknown): { ok: boolean; detail: string } {
		const validator = CompileSchema!(SubagentParams);
		const ok = validator.Check(value);
		const detail = [...validator.Errors(value)].map((error) => error.message).join(", ");
		return { ok, detail };
	}

	const base = { agent: "worker", task: "Fix the bug" };
	// Phase 6 siblings in flight: representative sample of removed fields.
	// The full dead-code sweep is a later phase; these pin the direction.
	const removedFields: Array<{ name: string; value: unknown }> = [
		// subagents_enable-era activation ceremony
		{ name: "subagents_enable", value: true },
		// bg_wait-era wait params
		{ name: "waitTimeoutMs", value: 60_000 },
		// model/fallback selection (config-owned now)
		{ name: "model", value: "anthropic/claude-opus-4-8" },
		{ name: "fast", value: true },
		// budget/timeout tuning (config-owned now)
		{ name: "toolBudget", value: { hard: 12 } },
		{ name: "toolTimeoutMs", value: 1000 },
		// agent management actions (Fleet/TUI-owned now)
		{ name: "config", value: { name: "reviewer", description: "Review things" } },
		// schedules/missions/watchdogs (not model-facing)
		{ name: "mission", value: { title: "Do things" } },
		{ name: "every", value: "30m" },
		// worktree admin (runtime-owned now)
		{ name: "worktree", value: true },
		{ name: "machine", value: "workmac" },
		// runtime mode tuning
		{ name: "async", value: true },
	];

	for (const field of removedFields) {
		it(`rejects ${field.name}`, () => {
			const result = check({ ...base, [field.name]: field.value });
			assert.equal(result.ok, false, `${field.name} should not validate (${result.detail})`);
		});
	}
});

describeIfSchemas("public boundary: control uses exact run IDs", () => {
	function check(value: unknown): boolean {
		return CompileSchema!(SubagentParams).Check(value);
	}

	it("steer/resume/interrupt carry the exact run id", () => {
		for (const action of ["steer", "resume", "interrupt"]) {
			assert.equal(check({ action, id: "78f659a3", message: "What are you blocked on?" }), true);
		}
	});

	// Exact IDs resolve end-to-end through the real run-ID resolver (foreground control).
	it("control resolves exact run IDs through the run-ID resolver", () => {
		const exactId = "78f659a3";
		const state = {
			foregroundControls: new Map([[exactId, { runId: exactId }]]),
			asyncJobs: new Map(),
			currentSessionId: "session-test",
		} as never;
		const resolved = resolveSubagentRunId(exactId, { state });
		assert.equal(resolved?.kind, "foreground");
		assert.equal(resolved?.id, exactId);
	});

	// Model/Fleet control path is exact-only: a strict prefix must NOT resolve.
	it("control rejects strict prefixes on the exact-only path", () => {
		const exactId = "78f659a3";
		const state = {
			foregroundControls: new Map([[exactId, { runId: exactId }]]),
			asyncJobs: new Map(),
			currentSessionId: "session-test",
		} as never;
		assert.equal(resolveSubagentRunId("78f659", { state, exactOnly: true }), undefined);
		const resolved = resolveSubagentRunId(exactId, { state, exactOnly: true });
		assert.equal(resolved?.kind, "foreground");
		assert.equal(resolved?.id, exactId);
	});

	// Ambiguous prefixes are impossible on the exact path: no throw, no resolution.
	it("control never reports ambiguous prefixes on the exact-only path", () => {
		const state = {
			foregroundControls: new Map([
				["78f659a3", { runId: "78f659a3" }],
				["78f659b4", { runId: "78f659b4" }],
			]),
			asyncJobs: new Map(),
			currentSessionId: "session-test",
		} as never;
		assert.equal(resolveSubagentRunId("78f659", { state, exactOnly: true }), undefined);
	});

	// Prefix convenience survives off the exact path (human supervisor/Fleet inspector surfaces).
	it("prefix convenience remains available off the exact path", () => {
		const exactId = "78f659a3";
		const state = {
			foregroundControls: new Map([[exactId, { runId: exactId }]]),
			asyncJobs: new Map(),
			currentSessionId: "session-test",
		} as never;
		const resolved = resolveSubagentRunId("78f659", { state });
		assert.equal(resolved?.kind, "foreground");
		assert.equal(resolved?.id, exactId);
	});

	// 06a enforces empty/missing control ids in rejectMissingControlRunId;
	// schema-level id stays optional, so drive the enforcer directly.
	it("rejects empty and missing run ids", () => {
		assert.ok(rejectMissingControlRunId({ action: "steer", id: "", message: "hi" }));
		assert.ok(rejectMissingControlRunId({ action: "steer", message: "hi" }));
		assert.equal(rejectMissingControlRunId({ action: "steer", id: "abc", message: "hi" }), undefined);
		assert.equal(rejectMissingControlRunId({}), undefined);
	});

	// Type.String already rejects non-string ids today — validates now, not sibling-dependent.
	it("rejects non-string run ids", () => {
		assert.equal(check({ action: "steer", id: 123, message: "hi" }), false);
	});
});

describe("public boundary: runs.run child params reject unknown keys", () => {
	function staticResult(paramsSource: string): { ok: boolean; messages: string } {
		assert.ok(validateWorkflowScript, "validateWorkflowScript should be importable");
		const script = `return await runs.run("one", ${paramsSource});`;
		const result = validateWorkflowScript(script);
		return { ok: result.ok, messages: result.errors.map((error) => error.message).join("; ") };
	}

	it("accepts the intended child allowlist", () => {
		assert.ok(validateWorkflowScript, "validateWorkflowScript should be importable");
		for (const params of [
			`{ agent: "worker", task: "check" }`,
			`{ agent: "worker", task: "check", cwd: "/repo/pkg" }`,
			`{ resume: "retained-run", task: "continue" }`,
		]) {
			const result = staticResult(params);
			assert.equal(result.ok, true, `${params} should validate statically (${result.messages})`);
		}
	});

	// Phase 6 workflow-child boundary (landed): model-authored runs.run/runs.all
	// children accept exactly { agent, task, cwd, resume, as, phase, label, lane, index }.
	// Execution tuning (async, output, outputMode, reads, progress) resolves from
	// agent definitions, workflow defaults, or operator config — never the model.
	// The static entry point rejects unknown keys offline; these pin the contract.
	for (const key of ["model", "toolBudget", "timeoutMs", "worktree", "fast", "action", "workflowScript", "async", "output", "outputMode", "reads", "progress"]) {
		it(`rejects unknown child key: ${key}`, () => {
			const params =
				key === "action"
					? `{ agent: "worker", task: "check", action: "list" }`
					: key === "workflowScript"
						? `{ agent: "worker", task: "check", workflowScript: "return 1;" }`
						: key === "toolBudget"
							? `{ agent: "worker", task: "check", toolBudget: { hard: 12 } }`
							: key === "worktree"
								? `{ agent: "worker", task: "check", worktree: true }`
								: key === "fast"
									? `{ agent: "worker", task: "check", fast: true }`
									: key === "timeoutMs"
										? `{ agent: "worker", task: "check", timeoutMs: 1000 }`
										: key === "async"
							? `{ agent: "worker", task: "check", async: true }`
							: key === "output"
								? `{ agent: "worker", task: "check", output: "inline" }`
								: key === "outputMode"
									? `{ agent: "worker", task: "check", outputMode: "inline" }`
									: key === "reads"
										? `{ agent: "worker", task: "check", reads: ["docs/scope.md"] }`
										: key === "progress"
											? `{ agent: "worker", task: "check", progress: true }`
											: `{ agent: "worker", task: "check", model: "anthropic/claude-opus-4-8" }`;
			const result = staticResult(params);
			assert.equal(result.ok, false, `runs.run ${key} should fail static validation (${result.messages})`);
		});
	}

	// The static entry point rejects unknown keys offline; this pins the intended contract.
	it("rejects an unknown child key through the workflow validator", () => {
		const result = staticResult(`runs.run("one", { agent: "worker", task: "check", bogusKey: true })`);
		assert.equal(result.ok, false, `runs.run bogusKey should fail static validation (${result.messages})`);
	});

	// Anti-growth lock: the exact model-authored child set. Any addition or
	// removal must update this test deliberately — sampling unknown keys is
	// not enough, since a newly added field would pass the rejection probes.
	// The source snapshot below fails on any allowlist change; the behavioral
	// probes confirm each allowed key validates and each removed tuning field
	// is rejected by name.
	it("locks the exact model-authored child allowlist", () => {
		const source = readFileSync(new URL("../../src/workflows/scripted-workflow.ts", import.meta.url), "utf8");
		const exactSet = `"agent", "task", "cwd", "resume", "as", "phase", "label", "lane", "index"`;
		const exactMessage = "Supported workflow child fields: agent, task, cwd, resume, as, phase, label, lane, index.";
		// All three seams carry the exact set: WORKER_SOURCE copy, module
		// allowlist, and each runtime error message.
		assert.equal(source.match(/allowedRunFields = new Set\(\[(.*?)\]\)/)?.[1], exactSet);
		assert.equal(source.match(/WORKFLOW_CHILD_ALLOWED_FIELDS = new Set\(\[(.*?)\]\)/)?.[1], exactSet);
		const messages = source.match(/Supported workflow child fields: [^.]*\./g) ?? [];
		assert.ok(messages.length >= 2, `expected runtime allowlist messages, found ${messages.length}`);
		for (const match of messages) assert.equal(match, exactMessage);
		// Every allowed key validates in a minimal child.
		for (const params of [
			`{ agent: "worker", task: "check" }`,
			`{ agent: "worker", task: "check", cwd: "/repo/pkg" }`,
			`{ resume: "retained-run", task: "continue" }`,
			`{ agent: "worker", task: "check", as: "helper" }`,
			`{ agent: "worker", task: "check", phase: "build" }`,
			`{ agent: "worker", task: "check", label: "step one" }`,
			`{ agent: "worker", task: "check", lane: { version: 1, key: "one" } }`,
			`{ agent: "worker", task: "check", index: 0 }`,
		]) {
			const script = `return await runs.run("one", ${params});`;
			const result = validateWorkflowScript!(script);
			assert.equal(result.ok, true, `${params} should validate statically (${JSON.stringify(result.errors)})`);
		}
		// Every removed execution-tuning field fails, naming the field.
		for (const key of ["async", "output", "outputMode", "reads", "progress"]) {
			const script = `return await runs.run("one", { agent: "worker", task: "check", ${key}: true });`;
			const result = validateWorkflowScript!(script);
			assert.equal(result.ok, false, `${key} should fail static validation`);
			assert.ok(
				result.errors.some((error) => error.message.includes(`unsupported field '${key}'`)),
				`${key} rejection should name the field (${JSON.stringify(result.errors)})`,
			);
		}
	});
});

describe("public boundary: phase 7c model-visible action surface", () => {
	it("exposes exactly steer, resume, interrupt, status, guide, validate", () => {
		assert.deepEqual([...MODEL_VISIBLE_SUBAGENT_ACTIONS], ["steer", "resume", "interrupt", "status", "guide", "validate"]);
	});

	it("keeps the internal action registry intact for internal/slash/RPC/Fleet callers", () => {
		for (const action of ["list", "get", "models", "children.list", "create", "stop", "dismiss", "refine", "mission.list", "schedule.list", "doctor", "debug.run", "grant-spawn-budget", "watchdog.status", "inspector.open", "project.open", "worktree.discard", "lane.status"]) {
			assert.ok((SUBAGENT_ACTIONS as readonly string[]).includes(action), `${action} must stay implemented internally`);
			assert.ok(!(MODEL_VISIBLE_SUBAGENT_ACTIONS as readonly string[]).includes(action), `${action} must not be model-visible`);
		}
	});

	it("unknown-action message suggests kept actions only", () => {
		for (const action of ["list", "stop", "refine", "bogus"]) {
			const message = unknownSubagentActionMessage(action);
			assert.match(message, new RegExp(`Unknown action: ${action}`));
			assert.match(message, /Valid: steer, resume, interrupt, status, guide, validate/);
			assert.doesNotMatch(message, /action: "list"/);
		}
	});

	function publicExecutor() {
		return createSubagentExecutor({
			pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as never,
			state: { asyncJobs: new Map(), foregroundControls: new Map() } as never,
			config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as never,
			asyncByDefault: false,
			tempArtifactsDir: os.tmpdir(),
			getSubagentSessionRoot: (parentSessionFile) => parentSessionFile ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl")) : os.tmpdir(),
			expandTilde: (value) => value,
			discoverAgents: () => ({ agents: [] }),
		});
	}

	function publicCtx() {
		return {
			cwd: os.tmpdir(),
			hasUI: false,
			sessionManager: { getSessionId() { return "boundary-test"; }, getSessionFile() { return null; } },
			modelRegistry: { getAvailable() { return []; } },
		} as never;
	}

	const removedActions = ["list", "get", "models", "children.list", "create", "update", "delete", "stop", "dismiss", "refine", "mission.create", "mission.list", "schedule.create", "schedule.list", "doctor", "debug.run", "grant-spawn-budget", "watchdog.status", "watchdog.check", "inspector.open", "project.open", "worktree.discard", "worktree.cleanup", "lane.status", "lane.recordMerge"];

	for (const action of removedActions) {
		it(`executePublic rejects removed action: ${action}`, async () => {
			const result = await publicExecutor().executePublic("boundary", { action } as never, new AbortController().signal, undefined, publicCtx());
			assert.equal(result.isError, true);
			const text = result.content.find((item) => item.type === "text")?.text ?? "";
			assert.match(text, new RegExp(`Unknown action: ${action}`));
			assert.match(text, /Fleet/);
		});
	}

	for (const action of ["steer", "resume", "interrupt", "status", "guide", "validate"]) {
		it(`executePublic does not apply the removal rejection to kept action: ${action}`, async () => {
			const params = action === "guide"
				? { action, topic: "definitely-not-a-topic" }
				: action === "validate"
					? { action, workflowScript: "return 1" }
					: { action, id: "deadbeef", message: "probe" };
			const result = await publicExecutor().executePublic("boundary", params as never, new AbortController().signal, undefined, publicCtx()).then(
				(resolved) => resolved.content.map((item) => item.type === "text" ? item.text : "").join("\n"),
				(error) => error instanceof Error ? error.message : String(error),
			);
			assert.doesNotMatch(result, /moved to Fleet/);
		});
	}
});
