/**
 * Native proof: leaf-runtime RPC gate end-to-end against the REAL
 * `@earendil-works/pi-coding-agent` SDK (never the test shim).
 *
 * Real SDK resolution at test time: `PI_SUBAGENTS_NATIVE_SDK_ROOT` when set,
 * else the machine-local sibling `../Pi-Atlas/node_modules/...` (gitignore
 * safe, no repo `node_modules` changes). Shim-only environments skip the
 * open-gate assertions and prove the fail-closed path instead.
 *
 * Allowlist proof: whenever a real SDK IS found, its manifest version MUST
 * be allowlisted or this suite fails — allowlist updates ride this proof.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
	RUNTIME_RPC_AUDITED_APIS,
	RUNTIME_RPC_READY_EVENT,
	RUNTIME_RPC_REQUEST_EVENT,
	VERIFIED_RUNTIME_HOST_VERSIONS,
	runtimeRpcReplyEvent,
} from "../../src/api/runtime-rpc.ts";
import { isRuntimeGateOpen, registerRuntimeRpcBridge } from "../../src/extension/runtime-rpc.ts";
import { LeafModelRuntime, RuntimeError } from "../../src/runs/runtime/leaf-model-runtime.ts";
import {
	buildLeafSessionSpec,
	executeLeafRun,
	LEAF_SYSTEM_PROMPT,
	probeRealLeafHost,
	resolveEffectiveCap,
	resolveExactModel,
} from "../../src/runs/runtime/leaf-model-session.ts";
import {
	buildNativeResourceLoaderOptions,
	createNativeLeafHost,
	type NativeSdkModules,
	type NativeSessionLike,
} from "../../src/runs/runtime/leaf-host-native.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function findRealSdkDir(): string | null {
	const candidates = [
		process.env.PI_SUBAGENTS_NATIVE_SDK_ROOT ?? null,
		join(REPO_ROOT, "..", "Pi-Atlas", "node_modules", "@earendil-works", "pi-coding-agent"),
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			if (!existsSync(join(candidate, "package.json"))) continue;
			const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as {
				name?: unknown;
				version?: unknown;
			};
			if (manifest.name !== "@earendil-works/pi-coding-agent") continue;
			if (typeof manifest.version !== "string" || manifest.version.includes("test-shim")) continue;
			return candidate;
		} catch {
			// Unreadable candidate; try the next one.
		}
	}
	return null;
}

const REAL_SDK_DIR = findRealSdkDir();

function readSdkVersion(sdkDir: string): string {
	const manifest = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")) as { version: string };
	return manifest.version;
}

class FakeEvents {
	readonly emitted: Array<{ event: string; data: unknown }> = [];
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => {
			this.handlers.set(
				event,
				(this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler),
			);
		};
	}

	emit(event: string, data: unknown): void {
		this.emitted.push({ event, data });
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}
}

function startParams(modelId: string) {
	return {
		modelId,
		prompt: "Do work.",
		maxOutputTokens: 64,
		timeoutMs: 5_000,
		correlation: { owner: "northstar", correlationId: "c", queryIndex: 0, role: "researcher", stage: "s", attempt: 0 },
	} as Parameters<LeafModelRuntime["start"]>[0];
}

if (!REAL_SDK_DIR) {
	describe("native host gate (shim-only environment: open-gate proof skipped)", () => {
		it("probe stays fail-closed without a real SDK installed", async () => {
			assert.equal(await probeRealLeafHost(), null);
			assert.equal(isRuntimeGateOpen("unknown"), false);
		});

		it("runtime.start with a null host fails closed as runtime_unavailable", () => {
			const runtime = new LeafModelRuntime({ host: null, cwd: "/repo" });
			assert.throws(
				() => runtime.start(startParams("openai/gpt-5-mini")),
				(error: unknown) => error instanceof RuntimeError && error.code === "runtime_unavailable",
			);
		});
	});
} else {
	const SDK_DIR: string = REAL_SDK_DIR;
	const SDK_VERSION = readSdkVersion(SDK_DIR);

	interface RealSdk {
		sdk: Record<string, unknown>;
		piAi: Record<string, unknown>;
		base: string;
	}

	async function loadRealSdk(): Promise<RealSdk> {
		const base = join(SDK_DIR, "package.json");
		const require = createRequire(base);
		// The real SDK manifest lacks a require-resolvable exports main
		// (`ERR_PACKAGE_PATH_NOT_EXPORTED` under require.resolve); the
		// exports map + dist paths below are its own canonical entries.
		const resolveEntry = (specifier: string, distFallback: string): string => {
			try {
				return require.resolve(specifier);
			} catch {
				const entry = join(SDK_DIR, distFallback);
				if (!existsSync(entry)) throw new Error(`real SDK entry missing: ${entry}`);
				return entry;
			}
		};
		const sdkPath = resolveEntry("@earendil-works/pi-coding-agent", "dist/index.js");
		const sdkDir = dirname(sdkPath);
		const piAiPkgDir = join(dirname(SDK_DIR), "pi-ai");
		const piAiPath = existsSync(join(piAiPkgDir, "dist", "compat.js"))
			? join(piAiPkgDir, "dist", "compat.js")
			: join(sdkDir, "..", "..", "pi-ai", "dist", "compat.js");
		if (!existsSync(piAiPath)) throw new Error(`real pi-ai entry missing: ${piAiPath}`);
		const sdk = (await import(pathToFileURL(sdkPath).href)) as unknown as Record<string, unknown>;
		const piAi = (await import(pathToFileURL(piAiPath).href)) as unknown as Record<string, unknown>;
		return { sdk, piAi, base };
	}

	function nativeModules(sdk: Record<string, unknown>, piAi: Record<string, unknown>): NativeSdkModules {
		return {
			SessionManager: sdk.SessionManager as unknown as NativeSdkModules["SessionManager"],
			createAgentSession: sdk.createAgentSession as unknown as NativeSdkModules["createAgentSession"],
			DefaultResourceLoader: sdk.DefaultResourceLoader as unknown as NativeSdkModules["DefaultResourceLoader"],
			...(typeof (sdk.SettingsManager as { create?: unknown } | undefined)?.create === "function"
				? { SettingsManager: sdk.SettingsManager as unknown as NativeSdkModules["SettingsManager"] }
				: {}),
			...(typeof sdk.getAgentDir === "function"
				? { getAgentDir: sdk.getAgentDir as NativeSdkModules["getAgentDir"] }
				: {}),
			getBuiltinProviders: piAi.getBuiltinProviders as NativeSdkModules["getBuiltinProviders"],
			getBuiltinModels: piAi.getBuiltinModels as NativeSdkModules["getBuiltinModels"],
			getBuiltinModel: piAi.getBuiltinModel as NativeSdkModules["getBuiltinModel"],
		};
	}

	describe(`native host gate (real SDK ${SDK_VERSION})`, () => {
		it("installed real-SDK version is allowlisted (allowlist rides this proof)", () => {
			assert.ok(
				(VERIFIED_RUNTIME_HOST_VERSIONS as readonly string[]).includes(SDK_VERSION),
				`real SDK ${SDK_VERSION} must be allowlisted or the gate cannot open`,
			);
		});

		it("probeRealLeafHost returns a working host stamped with the installed version", async () => {
			const { base } = await loadRealSdk();
			const host = await probeRealLeafHost({ resolutionBase: base });
			assert.ok(host, "probe must return a host for the verified real SDK");
			assert.equal(host.hostVersion, SDK_VERSION);
		});

		it("negotiate path: listModels resolves exact fullIds for audited APIs", async () => {
			const { base } = await loadRealSdk();
			const host = await probeRealLeafHost({ resolutionBase: base });
			assert.ok(host);
			const models = host.listModels();
			assert.ok(models.length > 0, "real catalog must list models");
			const audited = models.filter((entry) => (RUNTIME_RPC_AUDITED_APIS as readonly string[]).includes(entry.api ?? ""));
			assert.ok(audited.length > 0, "real catalog must carry audited APIs");
			const first = audited[0];
			assert.ok(first);
			const resolved = resolveExactModel(first.fullId, models);
			assert.equal(resolved.provider, first.provider);
			assert.equal(resolved.id, first.id);
		});

		it("one real prompt end-to-end without credentials or network, exact cap enforced", async () => {
			const { sdk, piAi, base } = await loadRealSdk();
			const modules = nativeModules(sdk, piAi);
			const scratch = join(tmpdir(), `pi-native-proof-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`);
			const agentDir = join(scratch, "agent");
			const cwd = join(scratch, "work");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(cwd, { recursive: true });

			const CAP = 16;
			const PROOF_TEXT = "native leaf proof output";
			const ModelRuntime = sdk.ModelRuntime as {
				create(options: Record<string, unknown>): Promise<{
					registerNativeProvider(provider: Record<string, unknown>): void;
				}>;
			};
			const modelRuntime = await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
				allowModelNetwork: false,
			});
			let streamCalls = 0;
			let seenModelMaxTokens: unknown;
			const proofMessage = {
				role: "assistant",
				content: [{ type: "text", text: PROOF_TEXT }],
				api: "openai-completions",
				provider: "native-proof",
				model: "proof-leaf-1",
				usage: {
					input: 3,
					output: CAP,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 3 + CAP,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const fakeStream = () => {
				const events = [
					{ type: "start", partial: proofMessage },
					{ type: "done", reason: "stop", message: proofMessage },
				];
				return {
					[Symbol.asyncIterator]: async function* () {
						yield* events;
					},
					result: async () => proofMessage,
				};
			};
			const syntheticModel = {
				id: "proof-leaf-1",
				name: "Proof Leaf 1",
				api: "openai-completions",
				provider: "native-proof",
				baseUrl: "http://127.0.0.1:1/",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				contextWindow: 4096,
				maxTokens: 64,
			};
			const streamFake = (model: { maxTokens?: unknown }) => {
				streamCalls += 1;
				seenModelMaxTokens = model?.maxTokens;
				return fakeStream();
			};
			modelRuntime.registerNativeProvider({
				id: "native-proof",
				name: "Native Proof",
				auth: {
					apiKey: {
						name: "Native proof key",
						resolve: async () => ({ auth: { apiKey: "proof-key" }, source: "native-proof" }),
					},
				},
				getModels: () => [syntheticModel],
				stream: streamFake,
				streamSimple: streamFake,
			});

			const synthModules: NativeSdkModules = {
				...modules,
				getBuiltinProviders: () => ["native-proof"],
				getBuiltinModels: () => [syntheticModel],
				getBuiltinModel: (provider: string, id: string) =>
					provider === "native-proof" && id === "proof-leaf-1" ? syntheticModel : undefined,
			};
			let seenSession: NativeSessionLike | undefined;
			const host = createNativeLeafHost(synthModules, SDK_VERSION, {
				modelRuntime,
				agentDir,
				onSession: (session) => {
					seenSession = session;
				},
			});
			const listed = host.listModels();
			assert.deepEqual(listed.map((entry) => entry.fullId), ["native-proof/proof-leaf-1"]);
			const model = resolveExactModel("native-proof/proof-leaf-1", listed);
			const cap = resolveEffectiveCap(model, CAP);
			assert.equal(cap, CAP);
			const spec = buildLeafSessionSpec(cwd, model, cap);
			assert.equal(spec.model.maxTokens, CAP);

			const handle = await host.createLeafSession(spec);
			assert.ok(seenSession, "adapter must surface the live session");
			assert.deepEqual(seenSession?.getActiveToolNames?.() ?? null, [], "zero tools on the leaf session");
			// The SDK builds the effective prompt as LEAF_SYSTEM_PROMPT plus a
			// trailing `Current working directory:` line (system-prompt.js);
			// assert our seam is the exact head with nothing else prepended.
			const effective = seenSession?.systemPrompt ?? "";
			assert.ok(
				effective.startsWith(LEAF_SYSTEM_PROMPT),
				`leaf system prompt seam heads the effective prompt (got ${JSON.stringify(effective.slice(0, 120))})`,
			);
			assert.equal(seenSession?.autoRetryEnabled, false, "auto-retry off");
			assert.equal(seenSession?.autoCompactionEnabled, false, "auto-compaction off");

			const result = await handle.prompt("Say hello in five words.");
			assert.equal(result.text, PROOF_TEXT, "final assistant message captured");
			assert.ok(result.text.length > 0);
			assert.equal(result.outputTokens, CAP, "positive integer usage at the exact cap");
			assert.equal(result.toolCalls, 0);
			assert.equal(result.providerInvocations, 1, "single-turn contract");
			assert.equal(streamCalls, 1, "exactly one provider invocation");
			assert.equal(seenModelMaxTokens, CAP, "requested cap enforced on the pi-ai Model object");

			await handle.dispose();

			const integrated = await executeLeafRun(host, {
				modelId: "native-proof/proof-leaf-1",
				prompt: "Say hello in five words.",
				maxOutputTokens: CAP,
				cwd,
			});
			assert.equal(integrated.output, PROOF_TEXT);
			assert.equal(integrated.outputTokens, CAP);
			assert.equal(streamCalls, 2, "integrated run disposes its own session after one turn");

			void base;
		});

		it("resource-loader seam carries the exact system prompt with zero ambient extensions", async () => {
			const { sdk } = await loadRealSdk();
			const scratch = join(tmpdir(), `pi-native-loader-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`);
			mkdirSync(scratch, { recursive: true });
			const agentDir = join(scratch, "agent");
			mkdirSync(agentDir, { recursive: true });
			const SettingsManager = sdk.SettingsManager as { create(cwd: string, agentDir?: string): unknown };
			const settings = SettingsManager.create(scratch, agentDir) as {
				setRetryEnabled(enabled: boolean): void;
				setCompactionEnabled(enabled: boolean): void;
			};
			settings.setRetryEnabled(false);
			settings.setCompactionEnabled(false);
			const DefaultResourceLoader = sdk.DefaultResourceLoader as new (options: Record<string, unknown>) => {
				reload(): Promise<unknown>;
				getSystemPrompt(): string | undefined;
				getExtensions(): { extensions: unknown[] };
			};
			const loader = new DefaultResourceLoader(buildNativeResourceLoaderOptions(scratch, agentDir, settings));
			await loader.reload();
			assert.equal(loader.getSystemPrompt(), LEAF_SYSTEM_PROMPT);
			assert.equal(loader.getExtensions().extensions.length, 0, "ambient extensions off");
		});

		it("gate is open: ready fires and bridge negotiates compatible:true", async () => {
			const { base } = await loadRealSdk();
			const host = await probeRealLeafHost({ resolutionBase: base });
			assert.ok(host);
			assert.equal(isRuntimeGateOpen(host.hostVersion), true);
			const models = host.listModels();
			const audited = models.find((entry) =>
				(RUNTIME_RPC_AUDITED_APIS as readonly string[]).includes(entry.api ?? ""),
			);
			assert.ok(audited, "negotiate needs one audited catalog model");
			const events = new FakeEvents();
			const runtime = new LeafModelRuntime({ host, cwd: REPO_ROOT });
			const bridge = registerRuntimeRpcBridge({ events, runtime, hostVersion: host.hostVersion });
			try {
				await bridge.emitReady();
				assert.ok(
					events.emitted.some((entry) => entry.event === RUNTIME_RPC_READY_EVENT),
					"open gate emits ready",
				);
				const requestId = "native-negotiate-1";
				const reply = new Promise<unknown>((resolve) => {
					const unsubscribe = events.on(runtimeRpcReplyEvent(requestId), (payload) => {
						unsubscribe();
						resolve(payload);
					});
				});
				events.emit(RUNTIME_RPC_REQUEST_EVENT, {
					version: 1,
					requestId,
					method: "negotiate",
					params: { modelId: audited.fullId },
				});
				const answered = (await reply) as { success: boolean; data: { compatible: boolean } };
				assert.equal(answered.success, true);
				assert.equal(answered.data.compatible, true);
			} finally {
				await bridge.dispose();
			}
		});

		it("runtime.start with a null host fails closed as runtime_unavailable (never crashes)", () => {
			const runtime = new LeafModelRuntime({ host: null, cwd: "/repo" });
			assert.throws(
				() => runtime.start(startParams("openai/gpt-5-mini")),
				(error: unknown) => error instanceof RuntimeError && error.code === "runtime_unavailable",
			);
		});
	});
}
