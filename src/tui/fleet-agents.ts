/**
 * Agents view for Fleet: list/create/edit/delete over the internal agent-management
 * handlers. The view calls those handlers directly and never constructs
 * model-tool `{ action: ... }` params; the model-visible management surface is
 * owned by a later workstream.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component } from "@earendil-works/pi-tui";
import { discoverAgentsAll, type AgentConfig, type AgentSource } from "../agents/agents.ts";
import {
	handleCreate,
	handleDelete,
	handleList,
	handleManagementAction,
	handleUpdate,
} from "../agents/agent-management.ts";
import { editableAgentConfig } from "../agents/agent-management.ts";
import { serializeAgent } from "../agents/agent-serializer.ts";
import { chooseModel, chooseThinking, saveAgentModel, saveAgentThinking, saveAgentSystemPrompt } from "../slash/subagents-admin.ts";
import type { Details, SubagentState } from "../shared/types.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export type AgentsContext = Parameters<typeof handleCreate>[1];
export type AgentsParams = Parameters<typeof handleCreate>[0];
export type AgentsResult = AgentToolResult<Details>;

/** Management entry points the view is allowed to call. All internal. */
export interface AgentsActions {
	list: (params: AgentsParams, ctx: AgentsContext) => AgentsResult;
	create: (params: AgentsParams, ctx: AgentsContext) => AgentsResult;
	update: (params: AgentsParams, ctx: AgentsContext) => AgentsResult;
	remove: (params: AgentsParams, ctx: AgentsContext) => AgentsResult;
	manage: (action: string, params: AgentsParams, ctx: AgentsContext) => AgentsResult;
	pickModel: (ctx: ExtensionContext, agent: AgentConfig) => Promise<string | undefined | null>;
	pickThinking: (ctx: ExtensionContext, agent: AgentConfig) => Promise<string | undefined | null>;
	saveModel: (ctx: ExtensionContext, agent: AgentConfig, selected: string | undefined) => Promise<string | null>;
	saveThinking: (ctx: ExtensionContext, agent: AgentConfig, selected: string | undefined) => Promise<string | null>;
	savePrompt: (ctx: ExtensionContext, agent: AgentConfig, prompt: string) => Promise<string | null>;
}

/**
 * Default actions call the internal agent-management handlers directly, never
 * the model-tool `{ action: ... }` surface.
 */
export const defaultAgentsActions: AgentsActions = {
	list: handleList,
	create: handleCreate,
	update: handleUpdate,
	remove: handleDelete,
	manage: handleManagementAction,
	pickModel: chooseModel,
	pickThinking: chooseThinking,
	saveModel: saveAgentModel,
	saveThinking: saveAgentThinking,
	savePrompt: saveAgentSystemPrompt,
};

export interface AgentsRow {
	name: string;
	source: AgentSource;
	filePath?: string;
	disabled: boolean;
	model?: string;
	thinking?: string;
	fallbackModels?: string[];
	description?: string;
}

export interface AgentsSnapshot {
	rows: AgentsRow[];
	error?: string;
}

export function collectAgentsSnapshot(
	cwd: string,
	options: { discover?: typeof discoverAgentsAll; provider?: string } = {},
): AgentsSnapshot {
	try {
		const discover = options.discover ?? discoverAgentsAll;
		const all = discover(cwd, options.provider);
		const rows: AgentsRow[] = [...all.project, ...all.user, ...all.package, ...all.builtin]
			.map((agent) => ({
				name: agent.name,
				source: agent.source,
				...(agent.filePath ? { filePath: agent.filePath } : {}),
				disabled: agent.disabled === true,
				...(agent.model ? { model: agent.model } : {}),
				...(agent.thinking ? { thinking: agent.thinking } : {}),
				...(agent.fallbackModels?.length ? { fallbackModels: [...agent.fallbackModels] } : {}),
				...(agent.description ? { description: agent.description } : {}),
			}))
			.sort((left, right) => left.name.localeCompare(right.name));
		return { rows };
	} catch (error) {
		return { rows: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Delete respects disable-vs-delete: only user/project files can be deleted. */
export function deletePlan(row: AgentsRow | undefined): { kind: "confirm-delete" } | { kind: "unavailable"; message: string } {
	if (!row) return { kind: "unavailable", message: "No agent is selected." };
	if (row.source === "user" || row.source === "project") return { kind: "confirm-delete" };
	return {
		kind: "unavailable",
		message: `'${row.name}' is a read-only ${row.source} agent and cannot be deleted. Use x to disable it instead.`,
	};
}

export function buildCreateParams(input: { name: string; description: string; agentScope: "user" | "project"; model?: string }): AgentsParams {
	return {
		config: JSON.stringify({
			name: input.name,
			description: input.description,
			scope: input.agentScope,
			...(input.model ? { model: input.model } : {}),
		}),
	};
}

export function buildUpdateParams(name: string, config: Record<string, unknown>): AgentsParams {
	return { agent: name, config: JSON.stringify(config) };
}

function resultText(result: AgentsResult): string {
	return result.content.find((item) => item.type === "text")?.text ?? "(no output)";
}

export interface AgentsViewOptions {
	actions?: AgentsActions;
	provider?: string;
	discover?: typeof discoverAgentsAll;
}

type Theme = ExtensionContext["ui"]["theme"];
type FleetTui = { requestRender(): void };

/** Interactive list following the Fleet inspector render/input patterns. */
export class SubagentAgentsComponent implements Component {
	private rows: AgentsRow[] = [];
	private selected = 0;
	private confirmingDelete = false;
	private notice: { text: string; isError?: boolean } | undefined;
	private busy = false;
	private readonly tui: FleetTui;
	private readonly theme: Theme;
	private readonly extCtx: ExtensionContext;
	private readonly mgmtCtx: AgentsContext;
	private readonly actions: AgentsActions;
	private readonly provider?: string;
	private readonly discover?: typeof discoverAgentsAll;

	constructor(tui: FleetTui, theme: Theme, extCtx: ExtensionContext, mgmtCtx: AgentsContext, options: AgentsViewOptions = {}) {
		this.tui = tui;
		this.theme = theme;
		this.extCtx = extCtx;
		this.mgmtCtx = mgmtCtx;
		this.actions = options.actions ?? defaultAgentsActions;
		this.provider = options.provider;
		this.discover = options.discover;
		this.refresh();
	}

	private refresh(): void {
		const previous = this.rows[this.selected]?.name;
		const snapshot = collectAgentsSnapshot(this.mgmtCtx.cwd, { ...(this.provider ? { provider: this.provider } : {}), ...(this.discover ? { discover: this.discover } : {}) });
		this.rows = snapshot.rows;
		if (snapshot.error) this.notice = { text: snapshot.error, isError: true };
		const preserved = previous ? this.rows.findIndex((row) => row.name === previous) : -1;
		this.selected = preserved >= 0 ? preserved : Math.min(this.selected, Math.max(0, this.rows.length - 1));
	}

	private setNotice(text: string, isError?: boolean): void {
		this.notice = { text, ...(isError ? { isError: true as const } : {}) };
		this.confirmingDelete = false;
		this.refresh();
		this.tui.requestRender();
	}

	private runBlocking(work: () => Promise<AgentsResult>): void {
		if (this.busy) return;
		this.busy = true;
		this.tui.requestRender();
		void work()
			.then((result) => this.setNotice(resultText(result), result.isError === true))
			.catch((error) => this.setNotice(error instanceof Error ? error.message : String(error), true))
			.finally(() => {
				this.busy = false;
				this.tui.requestRender();
			});
	}

	private selectedRow(): AgentsRow | undefined {
		return this.rows[this.selected];
	}

	private findAgent(name: string): AgentConfig | undefined {
		const all = (this.discover ?? discoverAgentsAll)(this.mgmtCtx.cwd, this.provider);
		return [...all.project, ...all.user, ...all.package, ...all.builtin].find((agent) => agent.name === name);
	}

	private async createFlow(): Promise<AgentsResult> {
		const name = await this.extCtx.ui.editor("New agent name", "");
		if (name === undefined || !name.trim()) return { content: [{ type: "text", text: "Agent creation canceled." }], isError: true, details: { mode: "management", results: [] } };
		const description = await this.extCtx.ui.editor("New agent description", "");
		if (description === undefined || !description.trim()) return { content: [{ type: "text", text: "Agent creation canceled." }], isError: true, details: { mode: "management", results: [] } };
		const scope = await this.extCtx.ui.select("Agent scope", ["user", "project"]);
		if (!scope) return { content: [{ type: "text", text: "Agent creation canceled." }], isError: true, details: { mode: "management", results: [] } };
		const result = this.actions.create(
			buildCreateParams({ name: name.trim(), description: description.trim(), agentScope: scope === "project" ? "project" : "user" }),
			this.mgmtCtx,
		);
		// The durable definition is produced by the same serializeAgent path the
		// existing flows use; verify it round-trips before reporting success.
		if (!result.isError) {
			const created = this.findAgent(name.trim());
			if (created) serializeAgent(editableAgentConfig(created));
		}
		return result;
	}

	private async editFlow(row: AgentsRow): Promise<AgentsResult> {
		const agent = this.findAgent(row.name);
		if (!agent) return { content: [{ type: "text", text: `Agent '${row.name}' is no longer available.` }], isError: true, details: { mode: "management", results: [] } };
		const field = await this.extCtx.ui.select("Edit field", [
			"model",
			"thinking",
			"prompt",
			"description",
		]);
		if (!field) return { content: [{ type: "text", text: "Edit canceled." }], isError: true, details: { mode: "management", results: [] } };
		if (field === "model") {
			const picked = await this.actions.pickModel(this.extCtx, agent);
			if (picked === null) return { content: [{ type: "text", text: "Edit canceled." }], isError: true, details: { mode: "management", results: [] } };
			const message = await this.actions.saveModel(this.extCtx, agent, picked);
			return message === null
				? { content: [{ type: "text", text: "Edit canceled." }], isError: true, details: { mode: "management", results: [] } }
				: { content: [{ type: "text", text: message }], details: { mode: "management", results: [] } };
		}
		if (field === "thinking") {
			const picked = await this.actions.pickThinking(this.extCtx, agent);
			if (picked === null) return { content: [{ type: "text", text: "Edit canceled." }], isError: true, details: { mode: "management", results: [] } };
			const message = await this.actions.saveThinking(this.extCtx, agent, picked);
			return message === null
				? { content: [{ type: "text", text: "Edit canceled." }], isError: true, details: { mode: "management", results: [] } }
				: { content: [{ type: "text", text: message }], details: { mode: "management", results: [] } };
		}
		if (field === "prompt") {
			const edited = await this.extCtx.ui.editor(`Edit '${agent.name}' system prompt`, agent.systemPrompt ?? "");
			if (edited === undefined) return { content: [{ type: "text", text: "Edit canceled." }], isError: true, details: { mode: "management", results: [] } };
			const message = await this.actions.savePrompt(this.extCtx, agent, edited);
			return message === null
				? { content: [{ type: "text", text: "Edit canceled." }], isError: true, details: { mode: "management", results: [] } }
				: { content: [{ type: "text", text: message }], details: { mode: "management", results: [] } };
		}
		const edited = await this.extCtx.ui.editor(`Edit '${agent.name}' description`, agent.description ?? "");
		if (edited === undefined) return { content: [{ type: "text", text: "Edit canceled." }], isError: true, details: { mode: "management", results: [] } };
		return this.actions.update(buildUpdateParams(agent.name, { description: edited }), this.mgmtCtx);
	}

	handleInput(data: string): void {
		if (this.confirmingDelete) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data.toLowerCase() === "n") {
				this.confirmingDelete = false;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "return") || data.toLowerCase() === "y") {
				const row = this.selectedRow();
				this.confirmingDelete = false;
				if (row) this.runBlocking(async () => this.actions.remove({ agent: row.name }, this.mgmtCtx));
				return;
			}
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + 1));
			this.tui.requestRender();
			return;
		}
		if (data === "c") {
			this.runBlocking(() => this.createFlow());
			return;
		}
		if (data === "e") {
			const row = this.selectedRow();
			if (!row) {
				this.setNotice("No agent is selected.", true);
				return;
			}
			this.runBlocking(() => this.editFlow(row));
			return;
		}
		if (data === "d") {
			const plan = deletePlan(this.selectedRow());
			if (plan.kind === "unavailable") {
				this.setNotice(plan.message, true);
				return;
			}
			this.confirmingDelete = true;
			this.tui.requestRender();
			return;
		}
		if (data === "x") {
			const row = this.selectedRow();
			if (!row) {
				this.setNotice("No agent is selected.", true);
				return;
			}
			const action = row.disabled ? "enable" : "disable";
			this.runBlocking(async () => this.actions.manage(action, { agent: row.name }, this.mgmtCtx));
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = [this.theme.bold("Subagent agents"), this.theme.fg("dim", "↑↓/jk select · c create · e edit · d delete · x disable/enable · Esc close"), ""];
		if (this.busy) lines.push(this.theme.fg("accent", "Working..."), "");
		else if (this.confirmingDelete) {
			const row = this.selectedRow();
			lines.push(this.theme.fg("warning", `Delete agent '${row?.name}' (${row?.source})? This removes its definition file.`));
			lines.push(this.theme.fg("dim", "Enter/Y confirms · N/Esc cancels"));
			lines.push("");
		} else if (this.notice) {
			lines.push(this.theme.fg(this.notice.isError ? "error" : "success", this.notice.text), "");
		}
		if (this.rows.length === 0) lines.push(this.theme.fg("dim", "No agents discovered. Press c to create one."));
		const maxRows = 20;
		const start = Math.max(0, Math.min(this.selected - maxRows + 1, Math.max(0, this.rows.length - maxRows)));
		for (let index = start; index < Math.min(this.rows.length, start + maxRows); index++) {
			const row = this.rows[index]!;
			const marker = index === this.selected ? "›" : " ";
			const state = row.disabled ? this.theme.fg("warning", "[disabled]") : this.theme.fg("success", "[enabled]");
			const model = row.model ?? "inherit";
			const thinking = row.thinking ? ` · ${row.thinking}` : "";
			const fallback = row.fallbackModels?.length ? ` · fallback: ${row.fallbackModels.join(",")}` : "";
			lines.push(`${marker} ${row.name} ${state} ${this.theme.fg("dim", `${row.source} · ${model}${thinking}${fallback}`)}`);
			if (index === this.selected && row.description) lines.push(this.theme.fg("dim", `  ${row.description}`.slice(0, Math.max(0, width))));
		}
		if (this.rows.length > maxRows) lines.push(this.theme.fg("dim", `Showing ${start + 1}-${Math.min(this.rows.length, start + maxRows)} of ${this.rows.length}`));
		return lines;
	}
}

export async function openSubagentAgents(ctx: ExtensionContext, mgmtCtx: AgentsContext, options: AgentsViewOptions = {}): Promise<void> {
	if (!ctx.hasUI) {
		const result = (options.actions ?? defaultAgentsActions).list({ agentScope: "both" }, mgmtCtx);
		ctx.ui.notify?.(resultText(result), result.isError ? "error" : "info");
		return;
	}
	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) => new SubagentAgentsComponent(tui, theme, ctx, mgmtCtx, options),
		{ overlay: true, overlayOptions: { anchor: "center", width: "90%", minWidth: 60, maxHeight: "85%", margin: 1 } },
	);
}

/** Fleet entry helper: management ctx derives from the shared subagent state. */
export function agentsContextForState(state: SubagentState, modelRegistry: AgentsContext["modelRegistry"]): AgentsContext {
	return { cwd: state.baseCwd, modelRegistry };
}
