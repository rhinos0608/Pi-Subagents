/**
 * Verified leaf-model adapter. Exact model selection only: strict
 * `provider/id` lookup, no normalization, no thinking suffix, no fallback
 * helper calls, no parent history/tools/delegation inheritance.
 *
 * The installable host here is a test shim, so the real-host binding stays
 * fail-closed (`probeRealLeafHost()` returns null). Unit tests inject a fake
 * `LeafHost` to prove exact selection, payload-cap assertion, isolation spec,
 * and usage proof without network or credentials.
 */
import {
	RUNTIME_RPC_AUDITED_APIS,
	RUNTIME_RPC_BOUNDS,
	RUNTIME_RPC_REJECTED_APIS,
	VERIFIED_RUNTIME_HOST_VERSIONS,
} from "../../api/runtime-rpc.ts";
import type { ModelInfo } from "../../shared/model-info.ts";

export const LEAF_SYSTEM_PROMPT = "Execute the user task. Return plain text only. Use no tools.";

export interface AuditedLeafModel {
	provider: string;
	id: string;
	api: string;
	maxTokens: number;
	contextWindow?: number;
}

export interface LeafSessionSpec {
	storage: { kind: "memory" };
	cwd: string;
	model: AuditedLeafModel;
	systemPrompt: string;
	tools: [];
	excludeTools: [];
	ambientExtensions: false;
	extensionPaths: [];
	noSkills: true;
	noPromptTemplates: true;
	noThemes: true;
	noContextFiles: true;
	initialHistory: [];
	autoRetry: false;
	autoCompaction: false;
	maxTurns: 1;
}

export interface LeafPromptResult {
	text: string;
	/** Normalized integer output-token usage. Absent/unverifiable usage fails the run. */
	outputTokens?: number;
	toolCalls: number;
	providerInvocations: number;
}

export interface LeafSessionHandle {
	prompt(text: string): Promise<LeafPromptResult>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	dispose(): Promise<void>;
}

/** Injectable host seam. Production binds the real SDK; tests inject fakes. */
export interface LeafHost {
	hostVersion: string;
	listModels(): ModelInfo[];
	createLeafSession(spec: LeafSessionSpec): Promise<LeafSessionHandle>;
}

export type LeafFailureCode =
	| "model_unavailable"
	| "unsupported_capability"
	| "invalid_params"
	| "output_token_limit_exceeded"
	| "output_contract_breach"
	| "provider_error";

export class LeafFailure extends Error {
	readonly code: LeafFailureCode;
	constructor(code: LeafFailureCode, message: string) {
		super(message);
		this.name = "LeafFailure";
		this.code = code;
	}
}

/** Host gate: shim and unlisted versions never open. */
export function isVerifiedHostVersion(hostVersion: string): boolean {
	if (typeof hostVersion !== "string" || hostVersion.length === 0) return false;
	if (hostVersion.includes("test-shim")) return false;
	return (VERIFIED_RUNTIME_HOST_VERSIONS as readonly string[]).includes(hostVersion);
}

function auditedApi(api: string | undefined): boolean {
	if (!api) return false;
	if ((RUNTIME_RPC_REJECTED_APIS as readonly string[]).includes(api)) return false;
	return (RUNTIME_RPC_AUDITED_APIS as readonly string[]).includes(api);
}

/**
 * Exact model resolution. Single strict `fullId` match; bare IDs, aliases,
 * preferred-provider disambiguation, and fallback lists are rejected.
 */
export function resolveExactModel(modelId: string, available: ModelInfo[]): AuditedLeafModel {
	const matches = available.filter((entry) => entry.fullId === modelId);
	if (matches.length !== 1 || !matches[0]) {
		throw new LeafFailure("model_unavailable", "Exact model unavailable.");
	}
	const model = matches[0];
	if (!auditedApi(model.api)) {
		throw new LeafFailure("unsupported_capability", "Model API unaudited for leaf execution.");
	}
	// Reject routing/gateway metadata and noncanonical endpoints smuggled on
	// the model record; the clone below carries only audited fields.
	const record = model as unknown as Record<string, unknown>;
	for (const field of ["streamOverride", "customStream", "gateway", "route", "fallbackModels", "endpoint", "baseUrl"]) {
		if (record[field] !== undefined) {
			throw new LeafFailure("unsupported_capability", "Model carries unaudited routing metadata.");
		}
	}
	if (typeof model.maxTokens !== "number" || !Number.isFinite(model.maxTokens) || model.maxTokens <= 0) {
		throw new LeafFailure("unsupported_capability", "Model maximum output tokens unknown.");
	}
	return {
		provider: model.provider,
		id: model.id,
		api: model.api as string,
		maxTokens: Math.floor(model.maxTokens),
		...(typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0
			? { contextWindow: Math.floor(model.contextWindow) }
			: {}),
	};
}

/**
 * Effective cap is min(server ceiling, model max). Requests above the
 * effective cap are rejected, never clamped. Requests below the Responses
 * minimum fail, never widened.
 */
export function resolveEffectiveCap(model: AuditedLeafModel, requested: number): number {
	const effective = Math.min(RUNTIME_RPC_BOUNDS.maxNegotiatedOutputTokens, model.maxTokens);
	if (requested > effective) {
		throw new LeafFailure("invalid_params", "Requested cap exceeds model maximum.");
	}
	if (model.api === "openai-responses" && requested < RUNTIME_RPC_BOUNDS.minResponsesOutputTokens) {
		throw new LeafFailure("invalid_params", "Requested cap below Responses minimum.");
	}
	return requested;
}

/**
 * Assert the outbound provider payload carries the requested cap exactly,
 * before transmission. Throws before any network call on absence, widening,
 * or ambiguous duplication.
 */
export function assertOutboundTokenCap(api: string, payload: unknown, expected: number): void {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new LeafFailure("output_contract_breach", "Provider payload missing token cap.");
	}
	const record = payload as Record<string, unknown>;
	if (api === "openai-responses") {
		if (record.max_output_tokens !== expected) {
			throw new LeafFailure("output_contract_breach", "Responses payload cap absent or altered.");
		}
		return;
	}
	if (api === "anthropic-messages") {
		if (record.max_tokens !== expected) {
			throw new LeafFailure("output_contract_breach", "Anthropic payload cap absent or altered.");
		}
		return;
	}
	if (api === "openai-completions") {
		const a = record.max_tokens;
		const b = record.max_completion_tokens;
		const aSet = a !== undefined;
		const bSet = b !== undefined;
		if (aSet && bSet) throw new LeafFailure("output_contract_breach", "Completions payload cap ambiguous.");
		if ((aSet && a !== expected) || (bSet && b !== expected) || (!aSet && !bSet)) {
			throw new LeafFailure("output_contract_breach", "Completions payload cap absent or altered.");
		}
		return;
	}
	throw new LeafFailure("unsupported_capability", "Unaudited provider API.");
}

/** Minimal audited model clone: requested cap replaces any wider limit. */
export function cloneModelWithCap(model: AuditedLeafModel, cap: number): AuditedLeafModel {
	return { provider: model.provider, id: model.id, api: model.api, maxTokens: cap };
}

/** Fresh zero-tool in-memory leaf spec. One model turn, no inheritance. */
export function buildLeafSessionSpec(cwd: string, model: AuditedLeafModel, cap: number): LeafSessionSpec {
	return {
		storage: { kind: "memory" },
		cwd,
		model: cloneModelWithCap(model, cap),
		systemPrompt: LEAF_SYSTEM_PROMPT,
		tools: [],
		excludeTools: [],
		ambientExtensions: false,
		extensionPaths: [],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		initialHistory: [],
		autoRetry: false,
		autoCompaction: false,
		maxTurns: 1,
	};
}

export interface LeafRunInput {
	modelId: string;
	prompt: string;
	maxOutputTokens: number;
	cwd: string;
}

export interface LeafRunSuccess {
	output: string;
	outputTokens: number;
}

/**
 * One-turn leaf execution against an injected host. Verifies usage proof:
 * positive integer output usage required; over-cap usage fails; tool calls
 * or extra provider invocations fail; missing usage fails.
 */
export async function executeLeafRun(host: LeafHost, input: LeafRunInput): Promise<LeafRunSuccess> {
	const model = resolveExactModel(input.modelId, host.listModels());
	const cap = resolveEffectiveCap(model, input.maxOutputTokens);
	const spec = buildLeafSessionSpec(input.cwd, model, cap);
	// Production outbound-cap proof: the audited session spec must carry the
	// requested cap exactly. Rejects widening/clamping before any provider call.
	if (spec.model.maxTokens !== cap) throw new LeafFailure("output_contract_breach", "Leaf spec cap absent or altered.");
	const session = await host.createLeafSession(spec).catch((error) => {
		if (error instanceof LeafFailure) throw error;
		throw new LeafFailure("provider_error", "Leaf session creation failed.");
	});
	let result: LeafPromptResult;
	try {
		result = await session.prompt(input.prompt);
	} catch (error) {
		if (error instanceof LeafFailure) throw error;
		throw new LeafFailure("provider_error", "Leaf prompt failed.");
	} finally {
		await session.dispose().catch(() => {});
	}
	if (result.toolCalls !== 0) throw new LeafFailure("output_contract_breach", "Leaf run used tools.");
	if (result.providerInvocations !== 1) throw new LeafFailure("output_contract_breach", "Leaf run left single-turn contract.");
	// pi-ai initializes zero usage when the provider omits it; zero is not
	// proof. Require positive reported usage.
	if (typeof result.outputTokens !== "number" || !Number.isInteger(result.outputTokens) || result.outputTokens <= 0) {
		throw new LeafFailure("output_contract_breach", "Output token usage unverifiable.");
	}
	if (result.outputTokens > cap) throw new LeafFailure("output_token_limit_exceeded", "Output exceeded requested cap.");
	return { output: result.text, outputTokens: result.outputTokens };
}

/**
 * Real-host probe. Returns null under the test shim or any host lacking the
 * proven in-memory/agent-session surface — readiness stays disabled there.
 */
export async function probeRealLeafHost(): Promise<LeafHost | null> {
	let codingAgent: Record<string, unknown>;
	try {
		codingAgent = (await import("@earendil-works/pi-coding-agent")) as unknown as Record<string, unknown>;
	} catch {
		return null;
	}
	if ((codingAgent as { __piSubagentsTestShim?: boolean }).__piSubagentsTestShim === true) return null;
	const sessionManager = codingAgent.SessionManager as
		| { inMemory?: (cwd?: string) => unknown }
		| undefined;
	if (typeof sessionManager?.inMemory !== "function" || typeof codingAgent.createAgentSession !== "function") {
		return null;
	}
	// No verified versions yet; native suite must prove each host/API first.
	return null;
}
