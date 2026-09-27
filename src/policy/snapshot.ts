/** Compact resolved-policy snapshot persisted to status.json at launch. */
export type PolicyOrigin = "explicit" | "agent" | "operator" | "default" | "unknown";
export type PolicyValueSource = "call" | "agent" | "config" | "none";

export interface ResolvedRunPolicy {
	version: 1;
	model?: string;
	modelOrigin: PolicyOrigin;
	thinking?: string;
	thinkingOrigin: PolicyOrigin;
	toolBudgetSoft?: number;
	toolBudgetHard?: number;
	toolBudgetSource: PolicyValueSource;
	timeoutMs?: number;
	timeoutSource: PolicyValueSource;
	context: "fresh" | "fork" | "mixed";
	worktree: boolean;
	isolation: "process";
	/** Union snapshot; undefined means names unrestricted. */
	allowedTools?: string[];
	/** Ordered model allowlist = per-attempt plan. */
	modelCandidates?: string[];
}

export function buildResolvedRunPolicy(input: {
	model?: string;
	modelOrigin?: string;
	thinking?: string | false;
	thinkingOverride?: unknown;
	agentThinking?: unknown;
	toolBudget?: { soft?: number; hard: number } | undefined;
	toolBudgetSource: PolicyValueSource;
	timeoutMs?: number;
	timeoutSource: PolicyValueSource;
	context?: "fresh" | "fork" | "mixed";
	worktree?: boolean;
	allowedTools?: string[];
	modelCandidates?: string[];
}): ResolvedRunPolicy {
	const modelOrigin = mapOrigin(input.modelOrigin);
	const thinkingOrigin = input.thinkingOverride !== undefined
		? "explicit"
		: input.agentThinking !== undefined
			? "agent"
			: input.thinking !== undefined && input.thinking !== false
				? "unknown"
				: "operator";
	return {
		version: 1,
		...(input.model ? { model: input.model } : {}),
		modelOrigin,
		...(typeof input.thinking === "string" ? { thinking: input.thinking } : {}),
		thinkingOrigin,
		...(input.toolBudget?.soft !== undefined ? { toolBudgetSoft: input.toolBudget.soft } : {}),
		...(input.toolBudget ? { toolBudgetHard: input.toolBudget.hard } : {}),
		toolBudgetSource: input.toolBudget ? input.toolBudgetSource : "none",
		...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
		timeoutSource: input.timeoutMs !== undefined ? input.timeoutSource : "none",
		context: input.context ?? "fresh",
		worktree: input.worktree ?? false,
		isolation: "process",
		...(input.allowedTools !== undefined ? { allowedTools: [...input.allowedTools] } : {}),
		...(input.modelCandidates?.length ? { modelCandidates: [...input.modelCandidates] } : {}),
	};
}

function mapOrigin(origin: string | undefined): PolicyOrigin {
	if (origin === "explicit") return "explicit";
	if (origin === "configured") return "agent";
	if (origin === "inherited") return "operator";
	if (origin === "default") return "default";
	if (origin === "explicit-child" || origin === "agent-config" || origin === "parent-session") {
		return origin === "explicit-child" ? "explicit" : origin === "agent-config" ? "agent" : "operator";
	}
	return "unknown";
}

/** Compact one-line-per-field render of the snapshot for WS-A surfaces. */
export function formatResolvedPolicySnapshotLines(snapshot: ResolvedRunPolicy): string[] {
	const lines = ["Effective policy (launch snapshot):"];
	lines.push(`  Model: ${snapshot.model ?? "default"} (${snapshot.modelOrigin})`);
	lines.push(`  Thinking: ${snapshot.thinking ?? "default"} (${snapshot.thinkingOrigin})`);
	lines.push(snapshot.toolBudgetHard !== undefined
		? `  Tool budget: hard ${snapshot.toolBudgetHard}${snapshot.toolBudgetSoft !== undefined ? ` (soft ${snapshot.toolBudgetSoft})` : ""} [${snapshot.toolBudgetSource}]`
		: "  Tool budget: not set");
	lines.push(snapshot.timeoutMs !== undefined
		? `  Timeout: ${snapshot.timeoutMs}ms [${snapshot.timeoutSource}]`
		: "  Timeout: not set");
	lines.push(`  Context: ${snapshot.context} · isolation: ${snapshot.isolation}${snapshot.worktree ? " · worktree" : ""}`);
	lines.push(`  Tool ceiling: ${snapshot.allowedTools === undefined ? "names unrestricted" : snapshot.allowedTools.length === 0 ? "none" : snapshot.allowedTools.join(", ")}`);
	if (snapshot.modelCandidates?.length) lines.push(`  Attempts: ${snapshot.modelCandidates.join(" -> ")}`);
	return lines;
}
