import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clearSkillCache } from "../../src/agents/skills.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";
import {
	buildCreateParams,
	buildUpdateParams,
	collectAgentsSnapshot,
	defaultAgentsActions,
	deletePlan,
} from "../../src/tui/fleet-agents.ts";
import {
	editableAgentConfig,
	handleCreate,
	handleDelete,
	handleList,
	handleManagementAction,
	handleUpdate,
} from "../../src/agents/agent-management.ts";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import { discoverAgentsAll } from "../../src/agents/agents.ts";

let tempDir = "";
let oldAgentDir: string | undefined;

function mgmtCtx() {
	return { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
}

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0]; assert.ok(first); assert.equal(first.type, "text"); assert.equal(typeof first.text, "string"); return first.text;
}
function setupFleetProject(): void {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-fleet-agents-")); fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
	oldAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent-home"); clearSkillCache();
}
function cleanupFleetProject(): void {
	if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
	delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]; clearSkillCache(); fs.rmSync(tempDir, { recursive: true, force: true });
}

describe("fleet agents view", () => {
	beforeEach(setupFleetProject);
	afterEach(cleanupFleetProject);

	it("uses the internal management handlers directly, not the model-tool surface", () => {
		assert.equal(defaultAgentsActions.list, handleList);
		assert.equal(defaultAgentsActions.create, handleCreate);
		assert.equal(defaultAgentsActions.update, handleUpdate);
		assert.equal(defaultAgentsActions.remove, handleDelete);
		assert.equal(defaultAgentsActions.manage, handleManagementAction);
		const params = buildCreateParams({ name: "x", description: "y", agentScope: "project" });
		assert.ok(!("action" in params), "view params must never carry a model-tool action field");
		const update = buildUpdateParams("x", { model: "openai/gpt-5-mini" });
		assert.ok(!("action" in update), "view params must never carry a model-tool action field");
	});

	it("lists project agents with enabled state via the snapshot", () => {
		defaultAgentsActions.create(
			buildCreateParams({ name: "fleet-worker", description: "Fleet worker", agentScope: "project", model: "openai/gpt-5-mini" }),
			mgmtCtx(),
		);
		const snapshot = collectAgentsSnapshot(tempDir);
		assert.equal(snapshot.error, undefined);
		const row = snapshot.rows.find((entry) => entry.name === "fleet-worker");
		assert.ok(row, "expected fleet-worker in snapshot");
		assert.equal(row.source, "project");
		assert.equal(row.disabled, false);
		assert.equal(row.model, "openai/gpt-5-mini");
	});

	it("create produces the same durable definition as the existing flow", () => {
		const result = defaultAgentsActions.create(
			buildCreateParams({ name: "durable-worker", description: "Durable worker", agentScope: "project", model: "openai/gpt-5-mini" }),
			mgmtCtx(),
		);
		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "durable-worker.md");
		assert.ok(fs.existsSync(filePath), "expected agent definition file");
		const discovered = discoverAgentsAll(tempDir).project.find((agent) => agent.name === "durable-worker");
		assert.ok(discovered);
		const durable = serializeAgent(editableAgentConfig(discovered));
		assert.match(durable, /name: durable-worker/);
		assert.match(durable, /model: openai\/gpt-5-mini/);
		assert.match(fs.readFileSync(filePath, "utf-8"), /model: openai\/gpt-5-mini/);
	});

	it("edit updates the agent-level model field", () => {
		defaultAgentsActions.create(
			buildCreateParams({ name: "edit-worker", description: "Edit worker", agentScope: "project" }),
			mgmtCtx(),
		);
		const result = defaultAgentsActions.update(buildUpdateParams("edit-worker", { model: "openai/gpt-5-nano" }), mgmtCtx());
		assert.equal(result.isError, false);
		const snapshot = collectAgentsSnapshot(tempDir);
		assert.equal(snapshot.rows.find((entry) => entry.name === "edit-worker")?.model, "openai/gpt-5-nano");
	});

	it("delete removes custom definitions; read-only agents resolve to disable instead", () => {
		defaultAgentsActions.create(
			buildCreateParams({ name: "gone-worker", description: "Gone worker", agentScope: "project" }),
			mgmtCtx(),
		);
		const row = collectAgentsSnapshot(tempDir).rows.find((entry) => entry.name === "gone-worker");
		assert.ok(row);
		assert.deepEqual(deletePlan(row), { kind: "confirm-delete" });
		const removed = defaultAgentsActions.remove({ agent: "gone-worker" }, mgmtCtx());
		assert.equal(removed.isError, false);
		assert.match(readText(removed), /Deleted agent/);
		assert.equal(collectAgentsSnapshot(tempDir).rows.some((entry) => entry.name === "gone-worker"), false);

		const builtin = collectAgentsSnapshot(tempDir).rows.find((entry) => entry.source === "builtin");
		if (builtin) {
			const plan = deletePlan(builtin);
			assert.equal(plan.kind, "unavailable");
			assert.match(plan.kind === "unavailable" ? plan.message : "", /disable/);
		} else {
			assert.deepEqual(deletePlan(undefined), { kind: "unavailable", message: "No agent is selected." });
		}
	});

	it("disable/enable toggles the snapshot disabled state", () => {
		defaultAgentsActions.create(
			buildCreateParams({ name: "toggle-worker", description: "Toggle worker", agentScope: "project" }),
			mgmtCtx(),
		);
		const disabled = defaultAgentsActions.manage("disable", { agent: "toggle-worker" }, mgmtCtx());
		assert.equal(disabled.isError, false);
		assert.equal(collectAgentsSnapshot(tempDir).rows.find((entry) => entry.name === "toggle-worker")?.disabled, true);
		const enabled = defaultAgentsActions.manage("enable", { agent: "toggle-worker" }, mgmtCtx());
		assert.equal(enabled.isError, false);
		assert.equal(collectAgentsSnapshot(tempDir).rows.find((entry) => entry.name === "toggle-worker")?.disabled, false);
	});
});
