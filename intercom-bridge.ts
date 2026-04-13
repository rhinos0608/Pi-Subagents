import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import type { ExtensionConfig } from "./types.ts";

const DEFAULT_INTERCOM_EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-intercom");
const DEFAULT_INTERCOM_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "intercom", "config.json");
const INTERCOM_BRIDGE_MARKER = "Intercom orchestration channel:";

export type IntercomBridgeMode = NonNullable<ExtensionConfig["intercomBridge"]>;

export interface IntercomBridgeState {
	active: boolean;
	mode: IntercomBridgeMode;
	orchestratorTarget?: string;
	extensionDir: string;
}

interface ResolveIntercomBridgeInput {
	mode: unknown;
	context: "fresh" | "fork" | undefined;
	orchestratorTarget?: string;
	extensionDir?: string;
	configPath?: string;
}

export function resolveIntercomBridgeMode(value: unknown): IntercomBridgeMode {
	if (value === "off" || value === "always" || value === "fork-only") return value;
	return "always";
}

function intercomEnabled(configPath: string): boolean {
	if (!fs.existsSync(configPath)) return true;
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { enabled?: unknown };
		return parsed.enabled !== false;
	} catch (error) {
		console.warn(`Failed to parse intercom config at '${configPath}'. Assuming enabled.`, error);
		return true;
	}
}

function extensionSandboxAllowsIntercom(extensions: string[] | undefined, extensionDir: string): boolean {
	if (extensions === undefined) return true;

	const intercomDir = path.resolve(extensionDir).replaceAll("\\", "/").toLowerCase();
	for (const entry of extensions) {
		const normalized = entry.trim().replaceAll("\\", "/").toLowerCase();
		if (normalized === "pi-intercom") return true;
		if (normalized === intercomDir) return true;
		if (normalized.startsWith(`${intercomDir}/`)) return true;
		if (normalized.endsWith("/pi-intercom")) return true;
		if (normalized.includes("/pi-intercom/")) return true;
	}
	return false;
}

function buildIntercomBridgeInstruction(orchestratorTarget: string): string {
	const escapedTarget = JSON.stringify(orchestratorTarget);
	return `${INTERCOM_BRIDGE_MARKER}
Use intercom only for coordination with the orchestrator session:
- Need a decision or blocked: intercom({ action: "ask", to: ${escapedTarget}, message: "<question>" })
- Completion/update: intercom({ action: "send", to: ${escapedTarget}, message: "DONE: <summary>" })
If intercom is unavailable in this run, continue the task normally.`;
}

export function resolveIntercomBridge(input: ResolveIntercomBridgeInput): IntercomBridgeState {
	const mode = resolveIntercomBridgeMode(input.mode);
	const extensionDir = path.resolve(input.extensionDir ?? DEFAULT_INTERCOM_EXTENSION_DIR);
	const orchestratorTarget = input.orchestratorTarget?.trim();

	if (mode === "off") {
		return { active: false, mode, extensionDir };
	}
	if (mode === "fork-only" && input.context !== "fork") {
		return { active: false, mode, extensionDir };
	}
	if (!orchestratorTarget) {
		return { active: false, mode, extensionDir };
	}
	if (!fs.existsSync(extensionDir)) {
		return { active: false, mode, extensionDir };
	}

	const configPath = path.resolve(input.configPath ?? DEFAULT_INTERCOM_CONFIG_PATH);
	if (!intercomEnabled(configPath)) {
		return { active: false, mode, extensionDir };
	}

	return {
		active: true,
		mode,
		orchestratorTarget,
		extensionDir,
	};
}

export function applyIntercomBridgeToAgent(agent: AgentConfig, bridge: IntercomBridgeState): AgentConfig {
	if (!bridge.active || !bridge.orchestratorTarget) return agent;
	if (!extensionSandboxAllowsIntercom(agent.extensions, bridge.extensionDir)) return agent;

	const tools = agent.tools && !agent.tools.includes("intercom")
		? [...agent.tools, "intercom"]
		: agent.tools;
	const instruction = buildIntercomBridgeInstruction(bridge.orchestratorTarget);
	const trimmedPrompt = agent.systemPrompt?.trim() || "";
	const systemPrompt = trimmedPrompt.includes(INTERCOM_BRIDGE_MARKER)
		? trimmedPrompt
		: trimmedPrompt
			? `${trimmedPrompt}\n\n${instruction}`
			: instruction;

	if (tools === agent.tools && systemPrompt === agent.systemPrompt) return agent;
	return {
		...agent,
		tools,
		systemPrompt,
	};
}
