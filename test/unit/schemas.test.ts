import assert from "node:assert/strict";
import { describe, it } from "node:test";

type JsonSchemaNode = Record<string, unknown>;

interface SubagentParamsSchema {
	properties?: {
		context?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		tasks?: {
			items?: {
				properties?: {
					count?: {
						minimum?: number;
						description?: string;
					};
				};
			};
		};
		concurrency?: {
			minimum?: number;
			description?: string;
		};
		workflow?: {
			type?: string;
			minLength?: number;
			description?: string;
		};
		args?: JsonSchemaNode;
		workflowScript?: {
			type?: string;
			minLength?: number;
			description?: string;
		};
		workflowScriptPath?: {
			type?: string;
			minLength?: number;
			description?: string;
		};
		globalConcurrencyLimit?: {
			type?: string;
			minimum?: number;
			maximum?: number;
			description?: string;
		};
		maxSubagentSpawnsPerRun?: {
			type?: string;
			minimum?: number;
			maximum?: number;
			description?: string;
		};
		preflight?: JsonSchemaNode;
		chatProgress?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		timeoutMs?: {
			minimum?: number;
			description?: string;
		};
		maxRuntimeMs?: {
			minimum?: number;
			description?: string;
		};
	id?: {
			type?: string;
			description?: string;
		};
		runId?: {
			type?: string;
			description?: string;
		};
		dir?: {
			type?: string;
			description?: string;
		};
		action?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		capabilities?: {
			type?: string;
			description?: string;
		};
		view?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		lines?: {
			minimum?: number;
			maximum?: number;
			description?: string;
		};
		control?: {
			properties?: {
				needsAttentionAfterMs?: { minimum?: number };
				activeNoticeAfterMs?: { minimum?: number };
				activeNoticeAfterTurns?: { minimum?: number };
				activeNoticeAfterTokens?: { minimum?: number };
				failedToolAttemptsBeforeAttention?: { minimum?: number };
				notifyOn?: { items?: { enum?: string[] } };
				notifyChannels?: { items?: { enum?: string[] } };
			};
		};
		skill?: JsonSchemaNode;
		config?: JsonSchemaNode;
		chain?: {
			items?: JsonSchemaNode & {
				properties?: Record<string, JsonSchemaNode>;
			};
		};
	};
}

function missingPackageName(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	return message.match(/Cannot find package ['"]([^'"]+)['"]/i)?.[1];
}

function anyOfBranches(schema: JsonSchemaNode | undefined): JsonSchemaNode[] {
	const anyOf = schema?.anyOf;
	if (!Array.isArray(anyOf)) return [];
	return anyOf.filter((branch): branch is JsonSchemaNode => !!branch && typeof branch === "object");
}

function hasAnyOfType(schema: JsonSchemaNode | undefined, type: string): boolean {
	return anyOfBranches(schema).some((branch) => branch.type === type);
}

function hasAnyOfArrayWithStringItems(schema: JsonSchemaNode | undefined): boolean {
	return anyOfBranches(schema).some((branch) => {
		if (branch.type !== "array") return false;
		const items = branch.items;
		return !!items && typeof items === "object" && (items as JsonSchemaNode).type === "string";
	});
}

function getPropertySchema(schema: JsonSchemaNode | undefined, path: string[]): JsonSchemaNode | undefined {
	let current: unknown = schema;
	for (const key of path) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as JsonSchemaNode).properties;
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current && typeof current === "object" ? current as JsonSchemaNode : undefined;
}

let schemas: Record<string, JsonSchemaNode> = {};
let SubagentParams: SubagentParamsSchema | undefined;
let schemasAvailable = true;
try {
	schemas = await import("../../src/extension/schemas.ts") as Record<string, JsonSchemaNode>;
	SubagentParams = schemas.SubagentParams as SubagentParamsSchema;
} catch (error) {
	if (missingPackageName(error) !== "typebox") throw error;
	schemasAvailable = false;
}
let CompileSchema: ((schema: unknown) => { Check(value: unknown): boolean; Errors(value: unknown): Iterable<{ message: string }> }) | undefined;
try {
	const compileModule = await import("typebox/compile") as { Compile: typeof CompileSchema };
	CompileSchema = compileModule.Compile;
} catch (error) {
	if (missingPackageName(error) !== "typebox") throw error;
	// The structural schema assertions below do not need the optional compiler package.
}

describe("SubagentParams schema", { skip: !schemasAvailable ? "typebox not available" : undefined }, () => {
	it("rejects output schema overrides on the public vocabulary; collect keeps object-only outputSchema", () => {
		assert.ok(SubagentParams);
		assert.ok(CompileSchema);
		const validator = CompileSchema!(SubagentParams);
		const base = { agent: "worker", task: "work" };
		// 9-field public vocabulary (topic added for action:"guide"; args added for workflowScript).
		assert.equal(validator.Check(base), true);
		assert.equal(validator.Check({ ...base, outputSchema: { type: "object" } }), false);
		assert.equal(validator.Check({ ...base, outputSchema: false }), false);
		const chainItem = schemas.ChainItem;
		assert.ok(chainItem);
		assert.equal(CompileSchema!(chainItem).Check({ agent: "worker", outputSchema: false }), true);
		assert.equal(CompileSchema!(chainItem).Check({ agent: "worker", outputSchema: null }), false);
		const collectSchema = schemas.DynamicCollectSchema;
		assert.ok(collectSchema);
		assert.equal(CompileSchema!(collectSchema).Check({ as: "all", outputSchema: { type: "object" } }), true);
		assert.equal(CompileSchema!(collectSchema).Check({ as: "all", outputSchema: false }), false);
	});

	it("context field is deleted: launch context is always fresh", () => {
		const contextSchema = SubagentParams?.properties?.context;
		assert.equal(contextSchema, undefined, "context should not be public");
	});

	it("exposes the 9-field single-schema vocabulary and omits removed workflow/resource modes", () => {
		assert.deepEqual(Object.keys(SubagentParams?.properties ?? {}), ["agent", "task", "action", "id", "message", "topic", "workflowScript", "args", "cwd"]);
		const properties = SubagentParams?.properties as Record<string, unknown> | undefined;
		for (const name of ["workflow", "workflowScriptPath", "globalConcurrencyLimit", "maxSubagentSpawnsPerRun", "preflight", "chatProgress", "worktree", "isolation", "gate", "acceptance", "mission", "config", "thinking", "model", "fast", "skill", "toolBudget", "toolTimeoutMs", "capabilities", "control", "agentContract", "outputSchema"]) {
			assert.equal(properties?.[name], undefined, `${name} should not be public`);
		}
		const workflowScript = SubagentParams?.properties?.workflowScript;
		assert.equal(workflowScript?.type, "string");
		assert.equal(workflowScript?.minLength, 1);
		assert.match(String(workflowScript?.description ?? ""), /Inline JavaScript statement body/);
		assert.match(String(workflowScript?.description ?? ""), /top-level await/);
		assert.match(String(workflowScript?.description ?? ""), /no runs.host/);
		assert.match(String(workflowScript?.description ?? ""), /guide workflows/);
		assert.equal(properties?.task?.type, "string");
		assert.match(String((properties?.task as JsonSchemaNode | undefined)?.description ?? ""), /one-child/i);
		assert.match(String((properties?.agent as JsonSchemaNode | undefined)?.description ?? ""), /one-child/i);
	});

	it("omits removed legacy and workflow-child-only fields", () => {
		for (const name of ["tasks", "chain", "concurrency", "chainDir", "step", "schedule", "scheduleName", "resume"]) {
			assert.equal((SubagentParams?.properties as Record<string, unknown> | undefined)?.[name], undefined, `${name} should not be public`);
		}
	});

	it("allows runtime validation of management and control action strings", () => {
		const actionSchema = SubagentParams?.properties?.action;
		assert.ok(actionSchema, "action schema should exist");
		assert.equal(actionSchema.type, "string");
		assert.equal(actionSchema.minLength, 1);
		assert.equal(actionSchema.enum, undefined);
		const description = String(actionSchema.description ?? "");
		assert.match(description, /Management\/control only; omit for execution/);
		assert.match(description, /Only steer, resume, interrupt, status, guide, and validate are exposed to the model/);
	});

	it("capabilities field is deleted: discovery goes through the list action", () => {
		assert.equal((SubagentParams?.properties as Record<string, unknown> | undefined)?.capabilities, undefined, "capabilities should not be public");
		if (CompileSchema) {
			const validator = CompileSchema(SubagentParams);
			assert.equal(validator.Check({ action: "list" }), true);
			assert.equal(validator.Check({ action: "list", capabilities: true }), false);
		}
	});

	it("agentContract is deleted from the public vocabulary (chain steps keep integer version bounds)", () => {
		assert.equal((SubagentParams?.properties as Record<string, JsonSchemaNode> | undefined)?.agentContract, undefined, "agentContract should not be public");
		const chainItem = schemas.ChainItem as JsonSchemaNode | undefined;
		const version = ((chainItem?.properties as Record<string, JsonSchemaNode> | undefined)?.agentContract?.properties as Record<string, JsonSchemaNode> | undefined)?.version;
		assert.ok(version, "chain-step agentContract.version schema should exist");
		assert.equal(version.type, "integer");
		assert.equal(version.minimum, 1);
		assert.equal(version.maximum, 1);
		assert.equal(version.enum, undefined);
	});

	it("omits removed timeout aliases and per-call timeout/runtime budget fields", () => {
		for (const name of ["timeoutMs", "maxRuntimeMs", "turnBudget", "usageBudget", "toolBudget"]) {
			assert.equal((SubagentParams?.properties as Record<string, unknown> | undefined)?.[name], undefined, `${name} should not be public`);
		}
	});

	it("omits per-call usage budget (backend-only tracking)", () => {
		const usageBudgetSchema = SubagentParams?.properties?.usageBudget;
		assert.equal(usageBudgetSchema, undefined, "usageBudget should not be public");
		});

	it("includes the id control field and omits removed control surfaces", () => {
		const idSchema = SubagentParams?.properties?.id;
		assert.ok(idSchema, "id schema should exist");
		assert.equal(idSchema.type, "string");
		assert.match(String(idSchema.description ?? ""), /status/i);
		assert.match(String(idSchema.description ?? ""), /control/i);
		const messageSchema = SubagentParams?.properties?.message;
		assert.ok(messageSchema, "message schema should exist");
		assert.equal(messageSchema.type, "string");
		for (const name of ["runId", "dir", "view", "lines", "additional", "control"]) {
			assert.equal((SubagentParams?.properties as Record<string, unknown> | undefined)?.[name], undefined, `${name} should not be public`);
		}
	});

	it("bg_wait is gone: no model-facing wait schema remains", () => {
		assert.equal(schemas.SubagentWaitParams, undefined);
	});

	it("does not emit description-only schema nodes", () => {
		const descriptionOnlyPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (Object.hasOwn(node, "description") && !Object.hasOwn(node, "type") && !Object.hasOwn(node, "anyOf")) {
					descriptionOnlyPaths.push(current.path);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(descriptionOnlyPaths, []);
	});

	it("does not emit array-typed schema nodes without items", () => {
		const missingItemsPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (node.type === "array" && !Object.hasOwn(node, "items")) {
					missingItemsPaths.push(current.path);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(missingItemsPaths, []);
	});

	it("keeps only top-level parameter descriptions to keep the provider payload compact", () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		const schema = SubagentParams as unknown as JsonSchemaNode;
		const serialized = JSON.stringify(schema);
		assert.ok(serialized.length <= 13_000, `expected concise schema at or under 13k chars, got ${serialized.length}`);
		assert.equal(serialized.includes('"$ref"'), false);
		assert.equal(serialized.includes('"$defs"'), false);
		assert.match(String((schema.properties as Record<string, JsonSchemaNode> | undefined)?.agent?.description ?? ""), /management target/);
		assert.match(String((schema.properties as Record<string, JsonSchemaNode> | undefined)?.task?.description ?? ""), /one-child/i);
		for (const name of ["acceptance", "mission"]) {
			assert.equal((schema.properties as Record<string, unknown> | undefined)?.[name], undefined, `${name} should not be public`);
		}

		const nestedDescriptionPaths: string[] = [];
		const stack: Array<{ path: string; value: unknown }> = [{ path: "SubagentParams", value: schema }];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (!current.value || typeof current.value !== "object") continue;
			const node = current.value as JsonSchemaNode;
			const pathParts = current.path.split(".");
			const isTopLevelParameter = pathParts.length === 3 && pathParts[0] === "SubagentParams" && pathParts[1] === "properties";
			if (typeof node.description === "string" && !isTopLevelParameter) nestedDescriptionPaths.push(`${current.path}.description`);
			if (Array.isArray(current.value)) {
				current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
			} else {
				for (const [key, value] of Object.entries(node)) stack.push({ path: `${current.path}.${key}`, value });
			}
		}
		assert.deepEqual(nestedDescriptionPaths, []);
	});

	it("preserves TypeBox metadata while pruning provider-visible descriptions", () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		const schema = SubagentParams as unknown as JsonSchemaNode;
		const rootKind = Object.getOwnPropertyDescriptor(schema, "~kind");
		assert.equal(rootKind?.value, "Object");
		assert.equal(rootKind?.enumerable, false);

		const agentSchema = getPropertySchema(schema, ["agent"]);
		assert.equal(Object.getOwnPropertyDescriptor(agentSchema, "~kind")?.enumerable, false);
		assert.equal(Object.getOwnPropertyDescriptor(agentSchema, "~optional")?.value, true);
		assert.equal(Object.getOwnPropertyDescriptor(agentSchema, "~optional")?.enumerable, false);
	});

	it("does not emit provider-rejected schema shapes", () => {
		const rejectedPaths: string[] = [];
		const rejectedKeywords = ["allOf", "const", "if", "then", "not"];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Inspecting JSON Schema enum representation is the portability contract under test.
				if (Array.isArray(node.enum) && node.enum.some((value) => typeof value !== "string")) {
					rejectedPaths.push(`${current.path}.enum`);
				}
				if (Array.isArray(node.type)) {
					rejectedPaths.push(`${current.path}.type`);
				}
				if (Object.hasOwn(node, "anyOf") && Object.hasOwn(node, "type")) {
					rejectedPaths.push(`${current.path}.type+anyOf`);
				}
				for (const keyword of rejectedKeywords) {
					if (Object.hasOwn(node, keyword)) rejectedPaths.push(`${current.path}.${keyword}`);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(rejectedPaths, []);
	});

	it("keeps the single schema free of flexible-field unions (moved to chain-internal schemas)", () => {
		const workflowScriptSchema = SubagentParams?.properties?.workflowScript;
		assert.ok(workflowScriptSchema, "workflowScript schema should exist");
		assert.equal(workflowScriptSchema.type, "string");
		// Phase 6a: config/mission/acceptance anyOf unions are not public. Chain
		// steps keep the acceptance union internally.
		for (const name of ["config", "mission", "acceptance", "thinking", "chain"]) {
			assert.equal((SubagentParams?.properties as Record<string, unknown> | undefined)?.[name], undefined, `${name} should not be public`);
		}
		const chainItem = schemas.ChainItem as JsonSchemaNode | undefined;
		assert.ok(chainItem, "ChainItem schema should exist");
		const acceptanceSchema = (chainItem.properties as Record<string, JsonSchemaNode> | undefined)?.acceptance;
		assert.ok(acceptanceSchema, "chain-step acceptance schema should exist");
		assert.equal(acceptanceSchema.type, undefined);
		assert.equal(hasAnyOfType(acceptanceSchema, "string"), true);
		assert.equal(hasAnyOfType(acceptanceSchema, "boolean"), true);
		const acceptanceStringBranches = anyOfBranches(acceptanceSchema).filter((branch) => branch.type === "string");
		const acceptanceLevelBranch = acceptanceStringBranches.find((branch) => Array.isArray(branch.enum) && branch.enum.includes("auto"));
		assert.deepEqual(acceptanceLevelBranch?.enum, ["auto", "attested", "checked"], "verified requires object form with runtime commands");
	});

	it("validates the 9-field vocabulary with TypeBox compiler", { skip: !CompileSchema ? "typebox compiler not available" : undefined }, () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		assert.ok(CompileSchema, "TypeBox compiler should exist");
		const validator = CompileSchema(SubagentParams);
		const validValues = [
			{},
			{ agent: "worker", task: "Fix" },
			{ workflowScript: "return await runs.run(\"one\", {agent: \"reviewer\", task: \"check\"})" },
			{ workflowScript: "return args.target;", args: { target: "src" } },
			{ cwd: "/tmp/work" },
			{ action: "list" },
			{ action: "steer", id: "run-1", message: "focus on tests" },
			{ action: "guide", topic: "agents" },
			{ action: "not-a-real-action" },
		];
		const invalidValues = [
			{ workflowScriptPath: "workflows/review.js" },
			{ toolTimeoutMs: 0 },
			{ toolTimeoutMs: 1000 },
			{ config: { name: "reviewer" } },
			{ config: null },
			{ agent: "worker", task: "Fix", acceptance: "auto" },
			{ agent: "worker", task: "Fix", acceptance: false },
			{ agent: "worker", task: "Fix", toolBudget: { hard: 3 } },
			{ agent: "worker", task: "Fix", capabilities: true },
			{ action: "steer", id: "run-1", index: 0, message: "focus on tests" },
		];

		for (const value of validValues) {
			assert.doesNotThrow(() => validator.Check(value), `validator should not throw for ${JSON.stringify(value)}`);
			assert.equal(
				validator.Check(value),
				true,
				`${JSON.stringify(value)} should validate: ${[...validator.Errors(value)].map((error) => error.message).join(", ")}`,
			);
		}
		for (const value of invalidValues) {
			assert.equal(validator.Check(value), false, `${JSON.stringify(value)} should not validate`);
		}
	});
});

describe("single public schema (Phase 6a: full/compact dual-mode removed)", { skip: !schemasAvailable ? "typebox not available" : undefined }, () => {
	it("has no CompactSubagentParams export", () => {
		assert.equal(schemas.CompactSubagentParams, undefined, "CompactSubagentParams should not exist");
	});

	it("has no createSubagentParamsSchema profile shim", () => {
		assert.equal(schemas.createSubagentParamsSchema, undefined, "createSubagentParamsSchema should not exist");
	});

	it("keeps the single schema at or under the 8,600-char ceiling", () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		const serialized = JSON.stringify(SubagentParams);
		assert.ok(serialized.length <= 8_600, `expected single schema at or under 8600 chars, got ${serialized.length}`);
		assert.deepEqual(Object.keys((SubagentParams as unknown as JsonSchemaNode).properties as Record<string, unknown>), ["agent", "task", "action", "id", "message", "topic", "workflowScript", "args", "cwd"]);
	});

	it("keeps load-bearing top-level annotations on the single schema", () => {
		const properties = (SubagentParams as unknown as { properties?: Record<string, JsonSchemaNode> } | undefined)?.properties;
		assert.ok(properties, "single-schema properties should exist");
		assert.match(String(properties.action?.description ?? ""), /Management\/control only/);
		assert.match(String(properties.workflowScript?.description ?? ""), /no runs\.host/);
		assert.match(String(properties.agent?.description ?? ""), /one-child/i);
		assert.match(String(properties.task?.description ?? ""), /one-child/i);
		assert.match(String(properties.id?.description ?? ""), /status\/control/);
	});

	it("validates representative fixtures against the single schema", { skip: !CompileSchema ? "typebox compiler not available" : undefined }, () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		assert.ok(CompileSchema, "TypeBox compiler should exist");
		const validator = CompileSchema(SubagentParams);
		const validValues = [
			{},
			{ agent: "worker", task: "Fix" },
			{ action: "list" },
			{ action: "steer", id: "run-1", message: "focus" },
			{ workflowScript: "return await runs.run(\"one\", {agent: \"worker\"})" },
		];
		const invalidValues = [
			{ agent: "worker", task: "Fix", acceptance: "auto" },
			{ action: "list", capabilities: true },
			{ agent: "worker", task: "Fix", toolBudget: { hard: 3 } },
			{ config: null },
		];
		for (const value of validValues) {
			assert.equal(validator.Check(value), true, `${JSON.stringify(value)} should validate`);
		}
		for (const value of invalidValues) {
			assert.equal(validator.Check(value), false, `${JSON.stringify(value)} should not validate`);
		}
	});
});
