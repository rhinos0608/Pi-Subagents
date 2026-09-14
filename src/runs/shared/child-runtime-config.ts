import type { JsonSchemaObject, ResolvedToolBudget, RunFanoutBudgetDescriptor, SubagentState } from "../../shared/types.ts";
import type { ThinkingLevel } from "../../shared/model-info.ts";
import type { NestedPathEntry } from "./nested-path.ts";
import type { PermissionRules } from "./permissions.ts";
import type { ChildWatchdogConfig, ChildWatchdogStatusEvent } from "../../watchdog/child-status.ts";
import type { ResolvedWaitToolConfig } from "../background/wait-config.ts";
import type { ChildToolDiagnostic } from "./tool-availability.ts";
import { isInternalChildTool } from "./tool-availability.ts";
import type { ResolvedSubagentCapabilityCeiling } from "./capability-ceiling.ts";
import type { RequiredChildExtensionSnapshot } from "../../shared/required-child-extensions.ts";

/**
 * Set in processes that host child sessions (the async runner). The extension
 * entry point registers nothing when it sees it, so an ambient copy of
 * pi-subagents loaded into a child session stays inert.
 */
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
/** Root parent session id the parent publishes for pi-permission-system ask forwarding. */
export const SUBAGENT_PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";

export interface ChildNestedRoute {
	rootRunId: string;
	eventSink: string;
	controlInbox: string;
	capabilityToken: string;
}

export interface ChildNestedParent {
	parentRunId: string;
	parentChildIndex?: number;
	depth: number;
	path: NestedPathEntry[];
}

export interface ChildPermissions {
	rules: PermissionRules;
	auditPath?: string;
}

export interface ChildStructuredOutput {
	schema: JsonSchemaObject;
	acceptanceReport?: "optional" | "required";
	/** Receives the validated value; `acceptanceReport` is undefined when the child omitted it. */
	capture: (value: unknown, acceptanceReport: unknown | undefined) => void;
}

export interface ChildSupervisorMetadata {
	channelDir: string;
	runId: string;
	agent: string;
	childIndex: number;
	orchestratorTarget?: string;
	orchestratorSessionId: string;
	childTarget?: string;
}

/**
 * Everything the child-side hooks need to know about the launch. The process
 * that hosts the child session builds it and passes it to the hooks directly.
 */
export interface ChildRuntimeConfig {
	runId?: string;
	agent?: string;
	childIndex?: number;
	fanoutChild: boolean;
	sessionName?: string;
	intercomSessionName?: string;
	orchestratorTarget?: string;
	orchestratorSessionId?: string;
	parentSessionId?: string;
	supervisorChannelDir?: string;
	/** Route the child reports nested runs on; set only for fanout-authorized children. */
	nestedRoute?: ChildNestedRoute;
	nestedParent?: ChildNestedParent;
	runFanoutBudget?: RunFanoutBudgetDescriptor;
	/** Nesting depth of this child (1 for a top-level parent's child). */
	depth: number;
	maxDepth?: number;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	/** Immutable root-parent host policy propagated to nested native launches. */
	requiredExtensions?: RequiredChildExtensionSnapshot;
	thinkingCeiling?: ThinkingLevel;
	inheritProjectContext?: boolean;
	inheritGlobalContext?: boolean;
	inheritSkills?: boolean;
	forkCacheKey?: string;
	permissions?: ChildPermissions;
	toolBudget?: ResolvedToolBudget;
	childWatchdog?: ChildWatchdogConfig;
	/** Receives child watchdog status events. */
	watchdogStatus?: (event: ChildWatchdogStatusEvent) => void;
	waitTool: ResolvedWaitToolConfig;
	runtimeState?: SubagentState;
	holdFinalDrain?: (held: boolean) => void;
	structuredOutput?: ChildStructuredOutput;
	requiredTools?: string[];
	mcpDirectTools?: string[];
	/** Receives the tool-availability diagnostic at every agent start; undefined when every required tool is present. */
	toolDiagnostic?: (diagnostic: ChildToolDiagnostic | undefined) => void;
	/** Receives the runtime-acknowledged extension ids when the child run ends. */
	runtimeAcknowledgements?: (ids: string[]) => void;
	fast: boolean;
}

export function childSupervisorMetadata(config: ChildRuntimeConfig): ChildSupervisorMetadata | undefined {
	if (!config.supervisorChannelDir || !config.runId || !config.agent || !config.orchestratorSessionId || config.childIndex === undefined) return undefined;
	return {
		channelDir: config.supervisorChannelDir,
		runId: config.runId,
		agent: config.agent,
		childIndex: config.childIndex,
		...(config.orchestratorTarget ? { orchestratorTarget: config.orchestratorTarget } : {}),
		orchestratorSessionId: config.orchestratorSessionId,
		...(config.intercomSessionName ? { childTarget: config.intercomSessionName } : {}),
	};
}

/**
 * Tools the prompt runtime itself registers. Their absence means our own
 * plumbing broke, so it stays fatal; every other absent tool (including the
 * external `intercom` provider tool) is disabled with a warning instead.
 */

function normalizeAvailableTools(availableTools: readonly (string | { name: string; label?: string })[]): Array<{ name: string; label?: string }> {
	return availableTools.map((tool) => (typeof tool === "string" ? { name: tool } : tool));
}

function isToolAvailable(identities: readonly { name: string; label?: string }[], required: string): boolean {
	// Internal plumbing must match the exact registered name: a display label
	// on an unrelated tool (e.g. `{ name: "bash", label: "bg_wait" }`) must
	// never prove the primitive exists.
	const identityStrict = isInternalChildTool(required) || isInternalChildTool(required.toLowerCase());
	for (const identity of identities) {
		if (identity.name === required) return true;
		if (identityStrict) continue;
		if (identity.label === required) return true;
		if (identity.name.toLowerCase() === required.toLowerCase()) return true;
		if (identity.label !== undefined && identity.label.toLowerCase() === required.toLowerCase()) return true;
	}
	return false;
}

/**
 * Compute the child tool-availability diagnostic; undefined when every required
 * tool is present. Absent external tools land in `disabled` (warn and
 * continue); absent internal coordination tools land in `missing` (fatal).
 * Matching accepts internal names and display labels, case-insensitively,
 * except internal coordination tools, which require the exact registered name.
 */
export function evaluateChildToolDiagnostic(config: Pick<ChildRuntimeConfig, "agent" | "requiredTools" | "mcpDirectTools">, availableTools: readonly (string | { name: string; label?: string })[]): ChildToolDiagnostic | undefined {
	if (!config.requiredTools) return undefined;
	const identities = normalizeAvailableTools(availableTools);
	const available = identities.map((identity) => identity.name);
	const absent = config.requiredTools.filter((name) => !isToolAvailable(identities, name));
	if (absent.length === 0) return undefined;
	const missing = absent.filter((name) => isInternalChildTool(name) || isInternalChildTool(name.toLowerCase()));
	const disabled = absent.filter((name) => !missing.includes(name));
	const missingMcpDirectTools = config.mcpDirectTools?.length ? disabled.filter((name) => config.mcpDirectTools!.includes(name)) : [];
	return {
		...(config.agent ? { agent: config.agent } : {}),
		required: config.requiredTools,
		available,
		missing,
		...(disabled.length > 0 ? { disabled } : {}),
		...(missingMcpDirectTools.length > 0 ? { missingMcpDirectTools } : {}),
	};
}
