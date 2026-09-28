import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, removeTempDir, resolveMockPiCallArgs, tryImport } from "../support/helpers.ts";
import { discoverAgents } from "../../src/agents/agents.ts";

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: unknown,
		) => Promise<{
			isError?: boolean;
			content: Array<{ text?: string }>;
			details?: {
				context?: "fresh" | "fork" | "mixed";
				mode?: "single" | "parallel" | "chain";
				asyncId?: string;
				results?: Array<{ context?: "fresh" | "fork"; detached?: boolean; exitCode?: number; skills?: string[] }>;
			};
		}>;
	};
}

const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!executorMod;
const createSubagentExecutor = executorMod?.createSubagentExecutor;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

interface SessionStubOptions {
	sessionFile?: string;
	leafId?: string | null;
}

interface SessionManagerStub {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	openSession(sessionFile: string): { createBranchedSession(leafId: string): string | undefined };
}

function makeSessionManagerRecorder(options: SessionStubOptions = {}) {
	const manager: SessionManagerStub = {
		getSessionId: () => "session-123",
		getSessionFile: () => options.sessionFile,
		getLeafId: () => (options.leafId === undefined ? "leaf-current" : options.leafId),
		openSession: () => ({
			createBranchedSession: () => "/tmp/child.jsonl",
		}),
	};
	return { manager };
}

function makeState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

describe("subagent launch context wiring (always-fresh)", { skip: !available ? "subagent executor not importable" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-fork-test-");
		mockPi.reset();
		mockPi.onCall({ output: "ok" });
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		removeTempDir(tempDir);
	});

	function makeExecutor() {
		return makeExecutorWithConfig({});
	}

	function makeExecutorWithConfig(config: Record<string, unknown>) {
		return makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "echo", description: "Echo test agent" },
				{ name: "second", description: "Second test agent" },
			],
			projectAgentsDir: null,
		}), config);
	}

	function makeExecutorWithDiscoverAgents(discoverAgentsImpl: typeof discoverAgents, config: Record<string, unknown> = {}) {
		let sessionName: string | undefined;
		const eventsApi = createEventBus();
		return Object.assign(createSubagentExecutor({
			pi: {
				events: eventsApi,
				getSessionName: () => sessionName,
				setSessionName: (name: string) => {
					sessionName = name;
				},
				sendMessage: () => {},
			},
			state: makeState(tempDir),
			config,
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: discoverAgentsImpl,
		}), { eventsApi });
	}

	function readCallArgs(): string[] {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded mock pi call");
		return readRecordedArgs(callFile, true);
	}

	function readAllCallArgs(): string[][] {
		return fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.map((name) => readRecordedArgs(name));
	}

	function readRecordedArgs(callFile: string, effective = false): string[] {
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[]; effectiveArgs?: string[] };
		assert.equal(typeof payload, "object", "expected recorded args payload");
		assert.notEqual(payload, null, "expected recorded args payload");
		assert.ok("args" in payload, "expected recorded args payload");
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return effective ? resolveMockPiCallArgs(payload) : payload.args;
	}

	function makeForkingSessionManagerRecorder(options: { sessionFile: string; leafId: string }) {
		const openedPaths: string[] = [];
		const branchedLeafIds: string[] = [];
		let counter = 0;
		fs.mkdirSync(path.dirname(options.sessionFile), { recursive: true });
		fs.writeFileSync(options.sessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => options.sessionFile,
			getLeafId: () => options.leafId,
			openSession: (sessionFile: string) => {
				openedPaths.push(sessionFile);
				return {
					createBranchedSession: (leafId: string) => {
						branchedLeafIds.push(leafId);
						counter++;
						const childSessionFile = path.join(tempDir, `fork-${counter}.jsonl`);
						fs.writeFileSync(childSessionFile, '{"type":"session","version":1,"id":"child","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
						return childSessionFile;
					},
				};
			},
		};
		return { manager, openedPaths, branchedLeafIds };
	}

	function writeAgent(projectRoot: string, name: string, model: string): void {
		const filePath = path.join(projectRoot, ".pi", "agents", `${name}.md`);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
			`---\nname: ${name}\ndescription: ${name} agent\nmodel: ${model}\n---\n\nUse ${model}.\n`,
			"utf-8",
		);
	}

	function writeProjectOverride(projectRoot: string, agentName: string, model: string): void {
		const settingsPath = path.join(projectRoot, ".pi", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({ subagents: { agentOverrides: { [agentName]: { model } } } }, null, 2),
			"utf-8",
		);
	}

	function makeCtx(sessionManager: SessionManagerStub) {
		return {
			cwd: tempDir,
			hasUI: false,
			ui: {},
			modelRegistry: { getAvailable: () => [] },
			sessionManager,
		};
	}

	it("runs a single agent when task is omitted", async () => {
		const { manager } = makeSessionManagerRecorder();
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		const args = readAllCallArgs()[0] ?? [];
		const taskArg = args.at(-1) ?? "";
		assert.equal(taskArg, "Task: ");
		const systemIndex = args.findIndex((arg) => arg === "--system-prompt" || arg === "--append-system-prompt");
		assert.notEqual(systemIndex, -1);
		assert.match(args[systemIndex + 1] ?? "", /## Acceptance Contract/);
	});

	it("launches fresh when no persisted parent session exists", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: undefined, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, "fresh");
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /delegated subagent running from a fork/);
	});

	it("launches fresh without forking the parent session", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager, openedPaths } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker" },
			],
			projectAgentsDir: null,
		}), {});

		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, "fresh");
		assert.deepEqual(openedPaths, []);
	});

	it("reports unknown top-level parallel agents without forking", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: undefined, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [{ name: "worker", description: "Worker" }],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ tasks: [{ agent: "worker", task: "one" }, { agent: "missing", task: "two" }] },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Unknown agent: missing/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /persisted parent session/);
	});

	it("launches fresh when the session path is not persisted yet", async () => {
		const parentSessionFile = path.join(tempDir, "unpersisted-parent.jsonl");
		const { manager } = makeSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, "fresh");
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /delegated subagent running from a fork/);
	});

	it("launches fresh when there is no current leaf", async () => {
		const parentSessionFile = path.join(tempDir, "parent-no-leaf.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const { manager } = makeSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: null });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, "fresh");
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /delegated subagent running from a fork/);
	});

	it("uses request cwd for management actions", async () => {
		const executor = makeExecutor();
		const worktreeDir = path.join(tempDir, "worktree");
		fs.mkdirSync(path.join(worktreeDir, ".pi"), { recursive: true });

		const result = await executor.execute(
			"id",
			{
				action: "create",
				cwd: "worktree",
				config: { name: "local-helper", description: "Local helper", scope: "project" },
			},
			new AbortController().signal,
			undefined,
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, false);
		assert.equal(fs.existsSync(path.join(worktreeDir, ".pi", "agents", "local-helper.md")), true);
		assert.equal(fs.existsSync(path.join(tempDir, ".pi", "agents", "local-helper.md")), false);
	});

	it("uses request cwd for execution-time agent discovery", async () => {
		const worktreeDir = path.join(tempDir, "worktree");
		writeAgent(tempDir, "echo", "openai/gpt-5-main");
		writeAgent(worktreeDir, "echo", "anthropic/claude-haiku-4-5");
		const executor = makeExecutorWithDiscoverAgents(discoverAgents);
		const task = `test ${path.basename(tempDir)}`;

		const result = await executor.execute(
			"id",
			{ agent: "echo", task, cwd: "worktree" },
			new AbortController().signal,
			undefined,
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, undefined);
		const args = readAllCallArgs()[0] ?? [];
		const taskArg = args.at(-1) ?? "";
		assert.equal(taskArg, `Task: ${task}`);
		const systemIndex = args.findIndex((arg) => arg === "--system-prompt" || arg === "--append-system-prompt");
		assert.notEqual(systemIndex, -1);
		assert.match(args[systemIndex + 1] ?? "", /## Acceptance Contract/);
		const modelIndex = args.indexOf("--model");
		assert.notEqual(modelIndex, -1);
		assert.equal(args[modelIndex + 1], "anthropic/claude-haiku-4-5");
	});

	it("uses request cwd for project builtin overrides during management", async () => {
		const tempHome = createTempDir("pi-subagent-home-");
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		const worktreeDir = path.join(tempDir, "worktree");
		fs.mkdirSync(worktreeDir, { recursive: true });
		writeProjectOverride(tempDir, "reviewer", "openai/gpt-5-main");
		writeProjectOverride(worktreeDir, "reviewer", "openai/gpt-5-worktree");
		const executor = makeExecutor();

		try {
			const result = await executor.execute(
				"id",
				{ action: "get", agent: "reviewer", cwd: "worktree" },
				new AbortController().signal,
				undefined,
				makeCtx(makeSessionManagerRecorder().manager),
			);

			assert.equal(result.isError, false);
			assert.match(result.content[0]?.text ?? "", /Model: openai\/gpt-5-worktree/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Model: openai\/gpt-5-main/);
		} finally {
			removeTempDir(tempHome);
		}
	});
});
