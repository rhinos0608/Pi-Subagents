/**
 * Native leaf host adapter: binds `LeafHost` to the real
 * `@earendil-works/pi-coding-agent` SDK surface.
 *
 * Dynamic surface only — this module never statically imports the SDK, so
 * shim-only installs never link the real surface. `probeRealLeafHost()` in
 * `./leaf-model-session.ts` resolves, verifies, and assembles the modules.
 *
 * Isolation contract per session:
 * - storage: `SessionManager.inMemory(spec.cwd)` (no session file persists)
 * - tools: `noTools: "all"` plus empty `excludeTools` (zero tools)
 * - system prompt: `LEAF_SYSTEM_PROMPT` via the resource-loader seam
 *   (`systemPrompt` option; ambient discovery off via `noExtensions`,
 *   `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`)
 * - model: exact pi-ai registry lookup, then the requested cap enforced on
 *   the pi-ai `Model` object itself (`maxTokens` replaced, never widened)
 * - retries/compaction: disabled on the settings manager and the session
 * - turns: single `prompt()` then dispose; `executeLeafRun` enforces exactly
 *   one provider invocation with zero tool calls (maxTurns 1 semantics)
 *
 * Every provider/SDK failure surfaces as `LeafFailure("provider_error")`
 * with a fixed message. Provider exception text never propagates.
 */
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import {
	LEAF_SYSTEM_PROMPT,
	LeafFailure,
	type LeafHost,
	type LeafPromptResult,
	type LeafSessionHandle,
	type LeafSessionSpec,
} from "./leaf-model-session.ts";

/** Minimal structural view of a pi-ai model record. */
export interface NativePiModel {
	provider: string;
	id: string;
	api: string;
	maxTokens: number;
	contextWindow?: number;
	[key: string]: unknown;
}

/** Minimal structural view of an AgentSession event. */
export interface NativeSessionEvent {
	type: string;
	message?: {
		role?: string;
		content?: Array<{ type?: string; text?: string }>;
		usage?: { output?: unknown };
	} | null;
}

/** Minimal structural view of an AgentSession. */
export interface NativeSessionLike {
	prompt(text: string, options?: Record<string, unknown>): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	dispose(): void | Promise<void>;
	subscribe(listener: (event: NativeSessionEvent) => void): () => void;
	getActiveToolNames?(): string[];
	setActiveToolsByName?(toolNames: string[]): void;
	setAutoRetryEnabled?(enabled: boolean): void;
	setAutoCompactionEnabled?(enabled: boolean): void;
	readonly systemPrompt?: string;
	autoRetryEnabled?: boolean;
	autoCompactionEnabled?: boolean;
}

/** Minimal structural view of the SDK settings manager. */
export interface NativeSettingsLike {
	setRetryEnabled(enabled: boolean): void;
	setCompactionEnabled(enabled: boolean): void;
}

/** Real-SDK modules assembled by the probe (or injected by tests). */
export interface NativeSdkModules {
	SessionManager: { inMemory(cwd?: string): unknown };
	createAgentSession(options: Record<string, unknown>): Promise<{ session: NativeSessionLike }>;
	DefaultResourceLoader: new (options: Record<string, unknown>) => {
		reload(options?: Record<string, unknown>): Promise<unknown>;
		getSystemPrompt?(): string | undefined;
	};
	SettingsManager?: { create(cwd: string, agentDir?: string): NativeSettingsLike };
	getAgentDir?: () => string;
	getBuiltinProviders(): string[];
	getBuiltinModels(provider: string): NativePiModel[];
	getBuiltinModel(provider: string, id: string): NativePiModel | undefined;
}

export interface NativeHostOverrides {
	/** Injected model/auth runtime (tests inject a synthetic no-auth provider). */
	modelRuntime?: unknown;
	/** Global config dir for SDK defaults. Defaults to the SDK default. */
	agentDir?: string;
	/** Observer seam for asserting live session state (tools, prompts, flags). */
	onSession?: (session: NativeSessionLike) => void;
}

/** Resource-loader options shared by the adapter and the native proof test. */
export function buildNativeResourceLoaderOptions(
	cwd: string,
	agentDir: string,
	settings: NativeSettingsLike | undefined,
): Record<string, unknown> {
	return {
		cwd,
		agentDir,
		...(settings ? { settingsManager: settings } : {}),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: LEAF_SYSTEM_PROMPT,
	};
}

/** Native `LeafHost` over real-SDK modules. All failures stay `LeafFailure`. */
export function createNativeLeafHost(
	modules: NativeSdkModules,
	hostVersion: string,
	overrides: NativeHostOverrides = {},
): LeafHost {
	return {
		hostVersion,
		listModels(): ModelInfo[] {
			const infos: ModelInfo[] = [];
			for (const provider of modules.getBuiltinProviders()) {
				for (const model of modules.getBuiltinModels(provider)) {
					infos.push(
						toModelInfo({
							provider: model.provider,
							id: model.id,
							api: model.api,
							contextWindow: model.contextWindow,
							maxTokens: model.maxTokens,
						}),
					);
				}
			}
			return infos;
		},
		async createLeafSession(spec: LeafSessionSpec): Promise<LeafSessionHandle> {
			// Exact registry lookup: no normalization, no aliases, no fallback.
			let catalog: NativePiModel | undefined;
			try {
				catalog = modules.getBuiltinModel(spec.model.provider, spec.model.id);
			} catch {
				catalog = undefined;
			}
			if (
				!catalog
				|| catalog.provider !== spec.model.provider
				|| catalog.id !== spec.model.id
				|| catalog.api !== spec.model.api
			) {
				throw new LeafFailure("model_unavailable", "Exact model unavailable.");
			}
			if (!Number.isInteger(spec.model.maxTokens) || spec.model.maxTokens <= 0) {
				throw new LeafFailure("output_contract_breach", "Leaf spec cap absent or altered.");
			}
			// Requested cap enforced on the pi-ai Model object itself.
			const cappedModel = { ...catalog, maxTokens: spec.model.maxTokens };
			let agentDir: string | undefined;
			try {
				agentDir = overrides.agentDir ?? modules.getAgentDir?.();
			} catch {
				agentDir = overrides.agentDir;
			}
			let settings: NativeSettingsLike | undefined;
			try {
				settings = agentDir ? modules.SettingsManager?.create(spec.cwd, agentDir) : undefined;
			} catch {
				settings = undefined;
			}
			try {
				settings?.setRetryEnabled(false);
			} catch {
				// Settings defaults already fail closed; retry stays as configured there.
			}
			try {
				settings?.setCompactionEnabled(false);
			} catch {
				// Settings defaults already fail closed; compaction stays as configured there.
			}
			if (!agentDir) throw new LeafFailure("provider_error", "Leaf session creation failed.");
			let loader: { reload(options?: Record<string, unknown>): Promise<unknown> };
			try {
				loader = new modules.DefaultResourceLoader(buildNativeResourceLoaderOptions(spec.cwd, agentDir, settings));
				await loader.reload();
			} catch {
				throw new LeafFailure("provider_error", "Leaf session creation failed.");
			}
			let session: NativeSessionLike;
			try {
				const result = await modules.createAgentSession({
					cwd: spec.cwd,
					sessionManager: modules.SessionManager.inMemory(spec.cwd),
					...(settings ? { settingsManager: settings } : {}),
					resourceLoader: loader,
					model: cappedModel,
					noTools: "all",
					excludeTools: [],
					...(overrides.modelRuntime !== undefined ? { modelRuntime: overrides.modelRuntime } : {}),
				});
				session = result.session;
			} catch {
				throw new LeafFailure("provider_error", "Leaf session creation failed.");
			}
			try {
				session.setAutoRetryEnabled?.(false);
			} catch {
				// Settings-manager flags above already disable retries.
			}
			try {
				session.setAutoCompactionEnabled?.(false);
			} catch {
				// Settings-manager flags above already disable compaction.
			}
			try {
				overrides.onSession?.(session);
			} catch {
				// Observer failures never break session creation.
			}
			return {
				async prompt(text: string): Promise<LeafPromptResult> {
					let toolCalls = 0;
					const assistantEnds: NonNullable<NativeSessionEvent["message"]>[] = [];
					let unsubscribe: (() => void) | undefined;
					try {
						unsubscribe = session.subscribe((event) => {
							if (!event || typeof event !== "object") return;
							if (event.type === "tool_execution_start") toolCalls += 1;
							if (event.type === "message_end" && event.message?.role === "assistant") {
								assistantEnds.push(event.message);
							}
						});
					} catch {
						throw new LeafFailure("provider_error", "Leaf prompt failed.");
					}
					try {
						await session.prompt(text);
						await session.waitForIdle();
					} catch {
						throw new LeafFailure("provider_error", "Leaf prompt failed.");
					} finally {
						try {
							unsubscribe?.();
						} catch {
							// Listener teardown never fails the run.
						}
					}
					const last = assistantEnds.at(-1);
					if (!last) throw new LeafFailure("provider_error", "Leaf prompt failed.");
					const outputText = Array.isArray(last.content)
						? last.content
							.filter((part) => part?.type === "text")
							.map((part) => part?.text ?? "")
							.join("")
						: "";
					const usageOutput = last.usage?.output;
					return {
						text: outputText,
						outputTokens: typeof usageOutput === "number" ? usageOutput : undefined,
						toolCalls,
						providerInvocations: assistantEnds.length,
					};
				},
				async abort(): Promise<void> {
					try {
						await session.abort();
					} catch {
						throw new LeafFailure("provider_error", "Leaf prompt failed.");
					}
				},
				async waitForIdle(): Promise<void> {
					try {
						await session.waitForIdle();
					} catch {
						throw new LeafFailure("provider_error", "Leaf prompt failed.");
					}
				},
				async dispose(): Promise<void> {
					await session.dispose();
				},
			};
		},
	};
}
