import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

const CUSTOM_TOOL_DESCRIPTION_FILE = "subagent-tool-description.md";
const CUSTOM_TOOL_DESCRIPTION_MAX_BYTES = 50 * 1024;

const EXECUTION_GUIDANCE = `Delegate one child with {agent,task?,cwd?}; for multi-child work pass exactly one workflow call with {workflowScript,args?,cwd?} and launch children inside it via runs.run/runs.all. args is a plain JSON object for workflowScript only (readable in the script as the frozen global 'args'; never secrets); omit args on agent/task launches and other actions. Omit action for execution; action is management/control only (steer, resume, interrupt, status, guide, validate). task excludes action; agent/task exclude workflow inputs.
Scripts are JavaScript statement bodies with explicit return and top-level await. Await runs.run(key,{agent,task}) before .output; await runs.all([{key,agent,task},...]) for an ordered array, not a key map. Pass worktree:true on a workflow child for its own managed worktree (needs a clean git tree). Observe every stored run promise with direct await, Promise.race, or Promise.all. Each subagent starts with fresh context: put the files, constraints, and success criteria it needs in its task. Do not hand one subagent a monolithic task; stage work sequentially or fan out across independent seams/files. Children sharing a cwd share its working tree. If writers may touch overlapping files and git status is clean, pass worktree:true on each workflow writer child; for single {agent,task} launches (no worktree field) create a worktree and pass it as the child's cwd; otherwise give each writer disjoint file ownership in the shared checkout, unless restricted to a single writer per cwd. Inspect owned runs with {action:"status",id}; control them with interrupt/resume/steer; check scripts offline with {action:"validate",workflowScript}. Read {action:"guide",topic:"tool-reference"} for controls and evidence gates, {action:"guide",topic:"workflows"} before advanced orchestration. On workflow, launch, or tooling failure: stop, report the exact failure plus run/status and repo/cwd/worktree evidence, and never silently switch execution modes without owner approval. Never include secrets in tasks or scripts.`;

/** Safety kernel retained in every description path. */
export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY KERNEL (authoritative):
- Authoritative preflight: {action:"guide",topic:"agents"}; executable, non-disabled only; PATH is not proof.
- No silent fallback on infra failure (lane infrastructure blocker): stop/report evidence; alternate execution needs owner approval.
- Ordinary child subagents are not orchestrators. Async completion wakes session; do not sleep or poll.
- Bind durable output to runs.run/runs.all; return references, artifacts, evidence, risks.
- Raw workflow resources own authority; no runs.host; relative I/O uses workflow cwd.
- Evidence: asyncId/asyncDir status.json/logs. Read guide tool-reference for controls/gates.`;

export const DEFAULT_SUBAGENT_TOOL_DESCRIPTION = `${EXECUTION_GUIDANCE}\n\n${SUBAGENT_SAFETY_GUIDANCE}`;

export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate work to child agents with subagents; compose multi-child work in one workflow call.";
export const SUBAGENT_TOOL_PROMPT_GUIDELINES = [
	"Each subagent starts with fresh context: put the files, constraints, and success criteria it needs in its task.",
];

const LEGACY_DESCRIPTION_MODES = new Set(["full", "compact"]);
const LEGACY_DESCRIPTION_PLACEHOLDERS = new Set(["fullDescription", "full", "compactDescription", "compact"]);

function isToolDescriptionMode(value: unknown): value is ToolDescriptionMode {
	return value === "default" || value === "custom";
}

function warn(options: ToolDescriptionOptions | undefined, message: string): void {
	(options?.warn ?? console.warn)(`[pi-subagents] ${message}`);
}

export interface ToolDescriptionOptions {
	cwd?: string;
	agentDir?: string;
	warn?: (message: string) => void;
}

export interface SubagentToolPromptMetadata {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export function buildSubagentToolPromptMetadata(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}): SubagentToolPromptMetadata {
	// A custom template is the operator's own prompt surface; attaching the
	// default snippet here would inject model instructions they did not ask for.
	if (config.toolDescriptionMode === "custom") return {};
	return {
		promptSnippet: SUBAGENT_TOOL_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_TOOL_PROMPT_GUIDELINES,
	};
}

export function resolveToolDescriptionMode(config: Pick<ExtensionConfig, "toolDescriptionMode">, options?: ToolDescriptionOptions): ToolDescriptionMode {
	const mode: unknown = config.toolDescriptionMode;
	if (mode === undefined) return "default";
	if (isToolDescriptionMode(mode)) return mode;
	if (typeof mode === "string" && LEGACY_DESCRIPTION_MODES.has(mode)) {
		warn(options, `toolDescriptionMode ${JSON.stringify(mode)} was removed; using the default description.`);
		return "default";
	}
	warn(options, `Ignoring invalid toolDescriptionMode ${JSON.stringify(mode)}; expected "default" or "custom".`);
	return "default";
}

function customDescriptionPaths(options?: ToolDescriptionOptions): string[] {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	return [
		path.join(getProjectConfigDir(cwd), CUSTOM_TOOL_DESCRIPTION_FILE),
		path.join(agentDir, CUSTOM_TOOL_DESCRIPTION_FILE),
	];
}

function renderCustomTemplate(template: string, options?: ToolDescriptionOptions): string {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	const projectConfigDir = getProjectConfigDir(cwd);
	let legacyWarned = false;
	const variables: Record<string, () => string> = {
		defaultDescription: () => DEFAULT_SUBAGENT_TOOL_DESCRIPTION,
		default: () => DEFAULT_SUBAGENT_TOOL_DESCRIPTION,
		fullDescription: () => DEFAULT_SUBAGENT_TOOL_DESCRIPTION,
		full: () => DEFAULT_SUBAGENT_TOOL_DESCRIPTION,
		compactDescription: () => DEFAULT_SUBAGENT_TOOL_DESCRIPTION,
		compact: () => DEFAULT_SUBAGENT_TOOL_DESCRIPTION,
		safetyGuidance: () => SUBAGENT_SAFETY_GUIDANCE,
		safety: () => SUBAGENT_SAFETY_GUIDANCE,
		agentDir: () => agentDir,
		projectConfigDir: () => projectConfigDir,
	};
	return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
		const replacement = variables[name];
		if (replacement) {
			if (LEGACY_DESCRIPTION_PLACEHOLDERS.has(name) && !legacyWarned) {
				legacyWarned = true;
				warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE}: {{${name}}} was removed; rendering the default description instead.`);
			}
			return replacement();
		}
		warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE}: unknown placeholder ${raw} left unchanged.`);
		return raw;
	});
}

function loadCustomToolDescription(options?: ToolDescriptionOptions): string | undefined {
	for (const filePath of customDescriptionPaths(options)) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			warn(options, `Failed to inspect custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!stat.isFile()) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is not a file.`);
			continue;
		}
		if (stat.size > CUSTOM_TOOL_DESCRIPTION_MAX_BYTES) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is larger than ${CUSTOM_TOOL_DESCRIPTION_MAX_BYTES} bytes.`);
			continue;
		}
		try {
			const template = fs.readFileSync(filePath, "utf-8").trim();
			if (!template) {
				warn(options, `Ignoring empty custom tool description '${filePath}'.`);
				continue;
			}
			const rendered = renderCustomTemplate(template, options).trim();
			if (!rendered) {
				warn(options, `Ignoring custom tool description '${filePath}' because it rendered empty.`);
				continue;
			}
			return rendered;
		} catch (error) {
			warn(options, `Failed to read custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return undefined;
}

function withMandatorySafetyGuidance(description: string): string {
	const customDescription = description
		.split(SUBAGENT_SAFETY_GUIDANCE)
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
	return customDescription
		? `${customDescription}\n\n${SUBAGENT_SAFETY_GUIDANCE}`
		: SUBAGENT_SAFETY_GUIDANCE;
}

export function buildSubagentToolDescription(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, options?: ToolDescriptionOptions): string {
	if (resolveToolDescriptionMode(config, options) === "custom") {
		const custom = loadCustomToolDescription(options);
		if (custom) return withMandatorySafetyGuidance(custom);
		warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE} was not found or valid for toolDescriptionMode "custom"; using default description.`);
	}
	return DEFAULT_SUBAGENT_TOOL_DESCRIPTION;
}
