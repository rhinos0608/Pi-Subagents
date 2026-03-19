import assert from "node:assert/strict";
import { describe, it } from "node:test";

interface RegisterSlashCommandsModule {
	registerSlashCommands?: (
		pi: {
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }): void;
			registerShortcut(key: string, spec: { handler(ctx: unknown): Promise<void> }): void;
			sendUserMessage(message: string): void;
		},
		state: {
			baseCwd: string;
			currentSessionId: string | null;
			asyncJobs: Map<string, unknown>;
			cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
			lastUiContext: unknown;
			poller: NodeJS.Timeout | null;
			completionSeen: Map<string, number>;
			watcher: unknown;
			watcherRestartTimer: ReturnType<typeof setTimeout> | null;
			resultFileCoalescer: { schedule(file: string, delayMs?: number): boolean; clear(): void };
		},
		getSubagentSessionRoot: (parentSessionFile: string | null) => string,
	) => void;
}

let registerSlashCommands: RegisterSlashCommandsModule["registerSlashCommands"];
let available = true;
try {
	({ registerSlashCommands } = await import("./slash-commands.ts") as RegisterSlashCommandsModule);
} catch {
	available = false;
}

function parseToolCallMessage(message: string): Record<string, unknown> {
	const prefix = "Call the subagent tool with these exact parameters: ";
	assert.ok(message.startsWith(prefix), "expected tool call prefix");
	return JSON.parse(message.slice(prefix.length)) as Record<string, unknown>;
}

function createState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

describe("slash command --fork flag", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	it("/run forwards context=fork and async for both flag orders", async () => {
		const sent: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const pi = {
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendUserMessage(message: string) {
				sent.push(message);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()), () => "/tmp/subagent-session");

		const ctx = {
			cwd: process.cwd(),
			ui: { notify: (_msg: string) => {} },
			sessionManager: { getSessionFile: () => undefined, getSessionId: () => "sid" },
			modelRegistry: { getAvailable: () => [] },
			hasUI: false,
		};

		await commands.get("run")!.handler("scout review --fork --bg", ctx);
		await commands.get("run")!.handler("scout review --bg --fork", ctx);

		const first = parseToolCallMessage(sent[0]!);
		assert.equal(first.context, "fork");
		assert.equal(first.async, true);

		const second = parseToolCallMessage(sent[1]!);
		assert.equal(second.context, "fork");
		assert.equal(second.async, true);
	});

	it("/chain and /parallel forward context=fork", async () => {
		const sent: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const pi = {
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendUserMessage(message: string) {
				sent.push(message);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()), () => "/tmp/subagent-session");

		const ctx = {
			cwd: process.cwd(),
			ui: { notify: (_msg: string) => {} },
			sessionManager: { getSessionFile: () => undefined, getSessionId: () => "sid" },
			modelRegistry: { getAvailable: () => [] },
			hasUI: false,
		};

		await commands.get("chain")!.handler("scout \"a\" -> planner --bg --fork", ctx);
		await commands.get("parallel")!.handler("scout \"a\" -> reviewer \"b\" --fork", ctx);

		const chainParams = parseToolCallMessage(sent[0]!);
		assert.equal(chainParams.context, "fork");
		assert.equal(chainParams.async, true);

		const parallelParams = parseToolCallMessage(sent[1]!);
		assert.equal(parallelParams.context, "fork");
		assert.equal(parallelParams.async, undefined);
	});
});
