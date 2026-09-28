/**
 * Operator tool allowlist (`subagents.allowedTools` in settings).
 *
 * Topology (supervisor-ordered authority simplification):
 *   operator allowlist → agent grants → dumb intersect (in `./child-tool-plan.ts`);
 *   external host ceilings live adjacent but separate in `./host-ceiling.ts`.
 *
 * The framework never infers permissions from roles or tool names. The
 * settings list is the ONLY in-package ceiling; it applies uniformly at every
 * launch and never inherits parent→child. Host re-exports below keep existing
 * import sites working while showing the split.
 */
export {
	SUBAGENT_CAPABILITY_CEILING_REGISTRY_KEY,
	SUBAGENT_CAPABILITY_CEILING_VERSION,
	assertAgentAllowedByCapabilityCeiling,
	capabilityCeilingAgentRestrictionMessage,
	capabilityCeilingAgentRestrictionSources,
	intersectSubagentCapabilityCeilings,
	isAgentAllowedByCapabilityCeiling,
	normalizeCapabilityCeilingAllowedAgents,
	parseSubagentCapabilityCeiling,
	registerSubagentCapabilityCeiling,
	resolveCurrentSubagentCapabilityCeiling,
	resolveSubagentCapabilityCeiling,
	type RegisterSubagentCapabilityCeilingOptions,
	type ResolvedSubagentCapabilityCeiling,
	type SubagentCapabilityAudit,
	type SubagentCapabilityCeiling,
	type SubagentCapabilityCeilingHandle,
} from "./host-ceiling.ts";

/** Validated operator allowlist: deduped non-empty tool names. */
export function normalizeOperatorAllowedTools(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("Invalid operator allowedTools; expected an array of non-empty strings.");
	const names = [...new Set(value.map((entry) => {
		if (typeof entry !== "string" || !entry.trim()) throw new Error("Invalid operator allowedTools; expected an array of non-empty strings.");
		return entry.trim();
	}))];
	return names.length > 0 ? names : undefined;
}

export interface OperatorToolIntersection {
	/** Requested tools surviving the allowlist, in requested order. */
	effective: string[];
	/** Requested tools removed by the allowlist (minimal debuggability list). */
	removed: string[];
}

/**
 * Dumb arithmetic: agent-requested tools ∩ operator allowlist.
 * Case-insensitive; no opinions, no audit prose.
 */
export function intersectOperatorAllowedTools(
	requested: readonly string[],
	allowed: readonly string[] | undefined,
): OperatorToolIntersection {
	if (allowed === undefined) return { effective: [...requested], removed: [] };
	const allowedLowered = new Set(allowed.map((tool) => tool.toLowerCase()));
	const effective: string[] = [];
	const removed: string[] = [];
	for (const tool of requested) {
		(allowedLowered.has(tool.toLowerCase()) ? effective : removed).push(tool);
	}
	return { effective, removed };
}
