import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	discoverAgents,
	discoverAgentsAll,
	formatUnknownAgentError,
	GATED_EXTERNAL_EXECUTOR_NAMES,
	unknownAgentDiagnosticContext,
} from "../../src/agents/agents.ts";

const tempDirs: string[] = [];
let tempHome = "";
let tempProject = "";
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value), "utf-8");
}

beforeEach(() => {
	tempHome = tempDir("pi-subagents-external-gate-home-");
	tempProject = tempDir("pi-subagents-external-gate-project-");
	previousHome = process.env.HOME;
	previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
});

afterEach(() => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (previousUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previousUserProfile;
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("external executor opt-in gate", () => {
	it("hides the six code-owned external profiles by default while keeping natives", () => {
		const effective = discoverAgents(tempProject, "both").agents;
		for (const name of GATED_EXTERNAL_EXECUTOR_NAMES) {
			assert.equal(effective.some((agent) => agent.name === name), false, name);
		}
		for (const name of ["scout", "researcher", "worker", "reviewer", "oracle", "delegate"]) {
			assert.ok(effective.some((agent) => agent.name === name), name);
		}
		const all = discoverAgentsAll(tempProject);
		for (const name of GATED_EXTERNAL_EXECUTOR_NAMES) {
			assert.equal(all.builtin.some((agent) => agent.name === name), false, name);
		}
	});

	it("fails closed naming the flag when a gated profile is requested by name", () => {
		const discovered = discoverAgents(tempProject, "both");
		const error = formatUnknownAgentError("codex-exec", unknownAgentDiagnosticContext(discovered));
		assert.match(error, /subagents\.enableExternalExecutors/);
		const nativeError = formatUnknownAgentError("worker", unknownAgentDiagnosticContext(discovered));
		assert.equal(nativeError.includes("enableExternalExecutors"), false);
	});

	it("shows the six profiles when the user setting opts in", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { enableExternalExecutors: true },
		});
		const names = discoverAgents(tempProject, "both").agents.map((agent) => agent.name);
		for (const name of GATED_EXTERNAL_EXECUTOR_NAMES) assert.ok(names.includes(name), name);
		assert.deepEqual(discoverAgentsAll(tempProject).builtin.filter((agent) => GATED_EXTERNAL_EXECUTOR_NAMES.includes(agent.name)).length, 6);
	});

	it("lets project settings win: project false beats user true, project true beats user false", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { enableExternalExecutors: true },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { enableExternalExecutors: false },
		});
		assert.equal(discoverAgents(tempProject, "both").agents.some((agent) => agent.name === "claude-code"), false);

		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { enableExternalExecutors: false },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { enableExternalExecutors: true },
		});
		assert.equal(discoverAgents(tempProject, "both").agents.some((agent) => agent.name === "claude-code"), true);
	});

	it("rejects a non-boolean flag value", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { enableExternalExecutors: "yes" },
		});
		assert.throws(() => discoverAgents(tempProject, "both"), /enableExternalExecutors.*boolean/);
	});

	it("keeps an operator-defined agent with a gated name discoverable while gated", () => {
		fs.mkdirSync(path.join(tempProject, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(tempProject, ".pi", "agents", "my-codex.md"),
			'---\nname: my-codex\ndescription: Operator-owned runner\nrunner:\n  type: external-cli\n  command: codex\n---\nRun.\n',
			"utf-8",
		);
		const effective = discoverAgents(tempProject, "both").agents;
		assert.ok(effective.some((agent) => agent.name === "my-codex"));
		assert.equal(effective.some((agent) => agent.name === "codex-exec"), false);
	});
});
