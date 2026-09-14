export interface ChildToolDiagnostic {
	agent?: string;
	required: string[];
	available: string[];
	/** Required internal coordination tools absent from the child registry; fatal. */
	missing: string[];
	/** Required external tools absent from the child registry; disabled with a warning, run continues. */
	disabled?: string[];
	missingMcpDirectTools?: string[];
}

/** Internal coordination tools the child runtime registers itself; absence is fatal, never warn-and-continue. */
export function isInternalChildTool(name: string): boolean {
	return name === "contact_supervisor" || name === "bg_wait" || name === "structured_output";
}

/** True when the diagnostic reports fatally missing internal tools. Disabled-only diagnostics warn and continue. */
export function hasFatalMissingTools(diagnostic: ChildToolDiagnostic | undefined): boolean {
	return (diagnostic?.missing.length ?? 0) > 0;
}

/** Human-readable warning for disabled (non-fatal) child tools. */
export function formatChildToolDisabledWarning(diagnostic: ChildToolDiagnostic): string | undefined {
	if (!diagnostic.disabled?.length) return undefined;
	const subject = diagnostic.agent ? `Agent '${diagnostic.agent}'` : "Subagent";
	return `${subject} continues without unavailable child tools: ${diagnostic.disabled.join(", ")}. For extension tools, add the provider path to \`subagentOnlyExtensions\` (child-only), \`extensions\`, or as a path-like entry in \`tools\`, while keeping each registered tool name in \`tools\`.`;
}

/**
 * Explain missing child tools. Foreground children run inside the parent
 * process and never load the parent's ambient extensions, so tools an ambient
 * extension registers (MCP tools, provider tools) only exist for background
 * children; the diagnostic says so instead of reporting a generic gap.
 */
export function formatChildToolDiagnostic(diagnostic: ChildToolDiagnostic, options: { host?: "parent" | "runner" } = {}): string {
	const subject = diagnostic.agent ? `Agent '${diagnostic.agent}'` : "Subagent";
	if (options.host === "parent") {
		return [
			`${subject} ran as a foreground child, which never loads the parent's ambient extensions, and these child tools were unavailable: ${diagnostic.missing.join(", ")}.`,
			"The `tools` field is a strict allowlist; it does not load extension code.",
			...(diagnostic.missingMcpDirectTools?.length
				? [`MCP direct tools missing from the child registry: ${diagnostic.missingMcpDirectTools.join(", ")}.`]
				: []),
			"Agents that need MCP tools (`mcpDirectTools`, or MCP tools from an ambient adapter such as pi-mcp-adapter) or models from a provider extension must run as background children (`async: true`), which load the ambient extensions.",
			"For extension tools a foreground child can load, add the provider path to `subagentOnlyExtensions` (child-only), `extensions`, or as a path-like entry in `tools`, while keeping each registered tool name in `tools`.",
		].join("\n");
	}
	return [
		...(diagnostic.missing.length > 0
			? [`${subject} requested unavailable child tools: ${diagnostic.missing.join(", ")}.`]
			: []),
		...(diagnostic.disabled?.length
			? [`${subject} continues without unavailable child tools: ${diagnostic.disabled.join(", ")}.`]
			: []),
		"The `tools` field is a strict allowlist; it does not load extension code.",
		...(diagnostic.missingMcpDirectTools?.length
			? [`Resolved MCP direct tools missing from the child registry: ${diagnostic.missingMcpDirectTools.join(", ")}. This indicates a host/pi-mcp-adapter registration problem, not a tool-call failure.`]
			: []),
		"For extension tools, add the provider path to `subagentOnlyExtensions` (child-only), `extensions`, or as a path-like entry in `tools`, while keeping each registered tool name in `tools`.",
		"For MCP tools, verify the MCP adapter configuration and selected tool names. For builtin tools, verify the name against the installed Pi version.",
		...(diagnostic.missing.some((name) => isInternalChildTool(name))
			? ["`contact_supervisor`, `bg_wait`, and `structured_output` are registered by the child runtime itself, not by extensions: their absence means runtime plumbing failed (check `waitTool` and supervisor-channel configuration), not tool allowlists."]
			: []),
	].join("\n");
}
