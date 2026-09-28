import * as fs from "node:fs";

type SubagentExecutionContext = "fresh" | "fork";

export interface PreferredForkSnapshot {
	parentSessionFile?: string | null;
	leafId?: string | null;
}

export interface SubagentLaunchContextInput {
	explicitContext?: SubagentExecutionContext;
	agentDefaultContext?: SubagentExecutionContext;
	defaultSubagentContext?: SubagentExecutionContext;
	canUseImplicitFork: boolean;
}

/** Resolve the actual launch context from explicit, global, and agent preferences. */
export function resolveSubagentLaunchContext(input: SubagentLaunchContextInput): SubagentExecutionContext {
	if (input.explicitContext !== undefined) return input.explicitContext;
	const preferredContext = input.defaultSubagentContext ?? input.agentDefaultContext ?? "fresh";
	return preferredContext === "fork" && input.canUseImplicitFork ? "fork" : "fresh";
}

export function canPreferForkFromSnapshot(input: PreferredForkSnapshot): boolean {
	if (!input.parentSessionFile || !input.leafId) return false;
	try {
		return fs.existsSync(input.parentSessionFile);
	} catch {
		return false;
	}
}
