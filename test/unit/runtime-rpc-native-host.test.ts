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
import { existsSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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
	LeafFailure,
	LEAF_SYSTEM_PROMPT,
	NATIVE_HOST_SPECIFIER,
	probeRealLeafHost,
	resolveEffectiveCap,
	resolveExactModel,
	STRICT_HOST_SEMVER,
} from "../../src/runs/runtime/leaf-model-session.ts";
import {
	buildNativeResourceLoaderOptions,
	createNativeLeafHost,
	type NativeSdkModules,
	type NativeSessionEvent,
	type NativeSessionLike,
} from "../../src/runs/runtime/leaf-host-native.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function findRealSdkDir(envRoot: string | null | undefined = process.env.PI_SUBAGENTS_NATIVE_SDK_ROOT): string | null {
	const candidates = [
		envRoot ?? null,
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

/**
 * Positive real-SDK checks: the resolved module must carry NO
 * `__piSubagentsTestShim` property in any form (any presence fails — not
 * truthy AND never `=== true`), AND `SessionManager.inMemory` plus
 * `createAgentSession` must both be functions. Anything else is a
 * shim/masquerade and must take the fail-closed path, never the open gate.
 */
/**
 * Resolve a package directory's own entry file from its manifest
 * (exports["."].import/default else main) — never via bare-specifier or CJS
 * resolution, which can land on a same-named package elsewhere. Returns null
 * when the entry is missing, escapes sdkDir, or is otherwise unusable.
 */
function readSdkEntryFile(sdkDir: string): string | null {
	try {
		const manifest = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")) as {
			exports?: unknown;
			main?: unknown;
		};
		const dot = (manifest.exports as Record<string, unknown> | undefined)?.["."];
		const entry =
			typeof dot === "string"
				? dot
				: dot !== null && typeof dot === "object"
					? ((): string | undefined => {
							const conditions = dot as Record<string, unknown>;
							const pick = conditions["import"] ?? conditions["default"];
							return typeof pick === "string" ? pick : undefined;
						})()
					: typeof manifest.main === "string"
						? manifest.main
						: undefined;
		if (!entry) return null;
		const entryPath = resolve(join(sdkDir, entry));
		const root = join(resolve(sdkDir), sep);
		if (entryPath !== resolve(sdkDir) && !entryPath.startsWith(root)) return null;
		if (!existsSync(entryPath)) return null;
		return entryPath;
	} catch {
		return null;
	}
}

async function passesPositiveRealSdkChecks(sdkDir: string): Promise<boolean> {
	try {
		// Derive the entry from this directory's own manifest — never resolve
		// the bare package specifier: Node self-reference scoping can land on
		// a same-named package elsewhere (e.g. a test shim) instead of sdkDir.
		const entryPath = readSdkEntryFile(sdkDir);
		if (!entryPath) return false;
		const sdkUrl = pathToFileURL(entryPath).href;
		const sdk = (await import(sdkUrl)) as unknown as Record<string, unknown>;
		if ("__piSubagentsTestShim" in sdk) return false;
		if ((sdk as { __piSubagentsTestShim?: unknown }).__piSubagentsTestShim) return false;
		if ((sdk as { __piSubagentsTestShim?: unknown }).__piSubagentsTestShim === true) return false;
		const sessionManager = sdk.SessionManager as { inMemory?: unknown } | undefined;
		if (typeof sessionManager?.inMemory !== "function") return false;
		if (typeof sdk.createAgentSession !== "function") return false;
		return true;
	} catch {
		return false;
	}
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

describe("env-var SDK masquerade lands fail-closed", () => {
	it("fake shim directory via the env var fails positive checks and never opens the gate", async () => {
		const fake = mkdtempSync(join(tmpdir(), "pi-fake-sdk-"));
		try {
			mkdirSync(join(fake, "dist"), { recursive: true });
			writeFileSync(
				join(fake, "package.json"),
				JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.1" }),
			);
			writeFileSync(
				join(fake, "dist", "index.js"),
				"export const __piSubagentsTestShim = true;\n" +
					"export const SessionManager = { inMemory() { return {}; } };\n" +
					"export const createAgentSession = async () => ({});\n" +
					"export const DefaultResourceLoader = function () {};\n",
			);
			// The old name + non-shim-version filter alone accepts this directory…
			assert.equal(findRealSdkDir(fake), fake);
			// …but the positive real-SDK checks reject it: shim flag present in any form.
			assert.equal(await passesPositiveRealSdkChecks(fake), false);
			// Fail-closed: the probe sees the shim flag and returns null; the gate stays closed.
			assert.equal(await probeRealLeafHost({ resolutionBase: join(fake, "package.json") }), null);
			assert.equal(isRuntimeGateOpen("0.0.0-pi-subagents-test-shim"), false);
		} finally {
			rmSync(fake, { recursive: true, force: true });
		}
	});
});

describe("probe version stamping rejects malformed semver (fail closed)", () => {
	const MALFORMED = [
		" 0.85.1",
		"0.85.1 ",
		"0.85.1\n",
		"\t0.85.1",
		"v0.85.1",
		"0.85",
		"0.85.1.0",
		"",
		"test-shim",
		"0.85.1\u0000",
		"0.85.1\u007f",
	];
	it("STRICT_HOST_SEMVER pins digits.digits.digits with optional prerelease", () => {
		assert.ok(STRICT_HOST_SEMVER.test("0.85.1"), "installed SDK style version accepted");
		assert.ok(STRICT_HOST_SEMVER.test("0.85.1-beta.2"), "prerelease accepted");
		for (const version of MALFORMED) {
			assert.equal(STRICT_HOST_SEMVER.test(version), false, `malformed ${JSON.stringify(version)} rejected`);
		}
	});
	for (const version of MALFORMED) {
		it(`malformed manifest version ${JSON.stringify(version)} → probe null`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-badver-"));
			try {
				mkdirSync(join(dir, "dist"), { recursive: true });
				writeFileSync(
					join(dir, "package.json"),
					JSON.stringify({ name: NATIVE_HOST_SPECIFIER, version }),
				);
				writeFileSync(join(dir, "dist", "index.js"), "export const marker = 1;\n");
				const validModule = {
					SessionManager: { inMemory: () => ({}) },
					createAgentSession: async () => ({ session: {} }),
					DefaultResourceLoader: function () {},
				};
				const probe = await probeRealLeafHost({
					resolutionBase: join(dir, "dist", "index.js"),
					load: async () => validModule,
				});
				assert.equal(probe, null, `malformed version ${JSON.stringify(version)} stays fail-closed`);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});

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
		// Manifest-derived entry (same helper as the positive checks): no
		// bare-specifier or CJS resolution anywhere in this file.
		const sdkPath = readSdkEntryFile(SDK_DIR);
		if (!sdkPath) throw new Error(`real SDK entry missing in ${base}`);
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
		it("resolved SDK passes positive real-SDK checks (env-var masquerade guard)", async () => {
			const { sdk } = await loadRealSdk();
			assert.ok(!("__piSubagentsTestShim" in sdk), "shim flag absent (no property presence)");
			assert.ok(!(sdk as { __piSubagentsTestShim?: unknown }).__piSubagentsTestShim, "shim flag not truthy");
			assert.ok(
				(sdk as { __piSubagentsTestShim?: unknown }).__piSubagentsTestShim !== true,
				"shim flag never === true",
			);
			assert.equal(
				typeof (sdk.SessionManager as { inMemory?: unknown } | undefined)?.inMemory,
				"function",
				"SessionManager.inMemory is a function",
			);
			assert.equal(typeof sdk.createAgentSession, "function", "createAgentSession is a function");
			assert.equal(await passesPositiveRealSdkChecks(SDK_DIR), true, "resolved dir passes positive checks");
		});

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
			let sessionDisposed = false;
			const host = createNativeLeafHost(synthModules, SDK_VERSION, {
				modelRuntime,
				agentDir,
				onSession: (session) => {
					seenSession = session;
					const origDispose = session.dispose.bind(session);
					session.dispose = async () => {
						sessionDisposed = true;
						await origDispose();
					};
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
			assert.equal(sessionDisposed, true, "session.dispose() was actually called");

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
				const answered = (await reply) as {
					version: number;
					requestId: string;
					method: string;
					success: boolean;
					data: { compatible: boolean; capabilities: Record<string, unknown> };
				};
				assert.equal(answered.version, 1, "reply envelope version is 1");
				assert.equal(answered.requestId, requestId, "reply echoes the sent requestId");
				assert.equal(answered.method, "negotiate", "reply method is negotiate");
				assert.equal(answered.success, true);
				assert.equal(answered.data.compatible, true);
				assert.ok(
					answered.data.capabilities && typeof answered.data.capabilities === "object",
					"capabilities object present",
				);
				for (
					const field of [
						"boundedCancellationSettlement",
						"leafOnlyExecution",
						"exactModelSelection",
						"maxOutputTokensEnforced",
						"backgroundExecution",
						"maxParallelRuns",
						"maxResultBytes",
						"outputModes",
					]
				) {
					assert.ok(field in answered.data.capabilities, `capability ${field} present`);
				}
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

// ---------------------------------------------------------------------------
// Adapter guard proof (fake SDK modules; runs with or without a real SDK).
// ---------------------------------------------------------------------------

type FakeAdapterListener = (event: NativeSessionEvent) => void;

class FakeAdapterSession {
	readonly listeners = new Set<FakeAdapterListener>();
	toolNames: string[] = [];
	promptText: string = `${LEAF_SYSTEM_PROMPT}\nCurrent working directory: /repo\n`;
	retryOn = true;
	compactionOn = true;
	throwOnSetRetry = false;
	stickRetry = false;
	throwOnDispose = false;
	abortCalls = 0;
	disposeCalls = 0;
	messageEnds = 1;
	beforeEmit: (() => Promise<void>) | null = null;

	get systemPrompt(): string {
		return this.promptText;
	}
	get autoRetryEnabled(): boolean {
		return this.retryOn;
	}
	get autoCompactionEnabled(): boolean {
		return this.compactionOn;
	}
	getActiveToolNames(): string[] {
		return [...this.toolNames];
	}
	setAutoRetryEnabled(enabled: boolean): void {
		if (this.throwOnSetRetry) throw new Error("retry setter boom");
		if (!this.stickRetry) this.retryOn = enabled;
	}
	setAutoCompactionEnabled(enabled: boolean): void {
		this.compactionOn = enabled;
	}
	subscribe(listener: FakeAdapterListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	async prompt(_text: string): Promise<void> {
		if (this.beforeEmit) await this.beforeEmit();
		for (let index = 0; index < this.messageEnds; index += 1) {
			for (const listener of [...this.listeners]) {
				listener({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "proof" }],
						usage: { output: 16 },
					},
				});
			}
		}
	}
	async abort(): Promise<void> {
		this.abortCalls += 1;
	}
	async waitForIdle(): Promise<void> {}
	dispose(): void {
		this.disposeCalls += 1;
		if (this.throwOnDispose) throw new Error("dispose boom");
	}
}

interface FakeSessionInit {
	messageEnds?: number;
	toolNames?: string[];
	promptText?: string;
	throwOnSetRetry?: boolean;
	stickRetry?: boolean;
	throwOnDispose?: boolean;
}

function makeAdapterHarness(sessionInit: FakeSessionInit = {}, harnessInit: { listThrows?: boolean } = {}): {
	session: FakeAdapterSession;
	seen: { options?: Record<string, unknown> };
	host: ReturnType<typeof createNativeLeafHost>;
} {
	const session = new FakeAdapterSession();
	Object.assign(session, sessionInit);
	const seen: { options?: Record<string, unknown> } = {};
	const fakeModel = { provider: "t", id: "m", api: "openai-completions", maxTokens: 64, contextWindow: 4096 };
	const modules: NativeSdkModules = {
		SessionManager: { inMemory: (_cwd?: string) => ({}) },
		createAgentSession: async (options: Record<string, unknown>) => {
			seen.options = options;
			return { session: session as unknown as NativeSessionLike };
		},
		DefaultResourceLoader: class {
			constructor(_options: Record<string, unknown>) {}
			async reload(): Promise<unknown> {
				return {};
			}
		} as unknown as NativeSdkModules["DefaultResourceLoader"],
		SettingsManager: {
			create: (_cwd: string, _agentDir?: string) => ({
				setRetryEnabled(_enabled: boolean): void {},
				setCompactionEnabled(_enabled: boolean): void {},
			}),
		},
		getAgentDir: () => "/agent",
		getBuiltinProviders: () => {
			if (harnessInit.listThrows) throw new Error("catalog boom");
			return ["t"];
		},
		getBuiltinModels: () => [fakeModel],
		getBuiltinModel: (provider: string, id: string) => (provider === "t" && id === "m" ? fakeModel : undefined),
	};
	const host = createNativeLeafHost(modules, "9.9.9-test", { agentDir: "/agent" });
	return { session, seen, host };
}

function adapterLeafSpec(): ReturnType<typeof buildLeafSessionSpec> {
	return buildLeafSessionSpec("/repo", { provider: "t", id: "m", api: "openai-completions", maxTokens: 64 }, 16);
}

describe("native leaf adapter guards (fake SDK modules)", () => {
	it("passes noTools all plus explicit builtin excludeTools", async () => {
		const { host, seen } = makeAdapterHarness();
		const handle = await host.createLeafSession(adapterLeafSpec());
		const options = seen.options as Record<string, unknown>;
		assert.equal(options.noTools, "all");
		assert.deepEqual(options.excludeTools, ["read", "bash", "edit", "write"]);
		await handle.dispose();
	});

	it("aborts after the first message_end and fails closed on two turns", async () => {
		const { host, session } = makeAdapterHarness({ messageEnds: 2 });
		await assert.rejects(
			executeLeafRun(host, { modelId: "t/m", prompt: "hi", maxOutputTokens: 16, cwd: "/repo" }),
			/single-turn/,
		);
		assert.ok(session.abortCalls >= 1, "adapter aborted after the first assistant message_end");
	});

	it("rejects a non-empty tool registry at creation and disposes the session", async () => {
		const { host, session } = makeAdapterHarness({ toolNames: ["read"] });
		await assert.rejects(host.createLeafSession(adapterLeafSpec()), /used tools/);
		assert.equal(session.disposeCalls, 1, "rejected session is disposed");
	});

	it("rejects tools activated between creation and prompt", async () => {
		const { host, session } = makeAdapterHarness();
		const handle = await host.createLeafSession(adapterLeafSpec());
		session.toolNames.push("read");
		await assert.rejects(handle.prompt("hi"), /used tools/);
		await handle.dispose();
	});

	it("rejects an altered system prompt", async () => {
		const { host } = makeAdapterHarness({ promptText: "evil override" });
		await assert.rejects(host.createLeafSession(adapterLeafSpec()), /system prompt/);
	});

	it("rejects when retry/compaction cannot be verified off (no silent catch)", async () => {
		const throwing = makeAdapterHarness({ throwOnSetRetry: true });
		await assert.rejects(throwing.host.createLeafSession(adapterLeafSpec()), /retry/);
		const stuck = makeAdapterHarness({ stickRetry: true });
		await assert.rejects(stuck.host.createLeafSession(adapterLeafSpec()), /retry/);
	});

	it("fails closed when abort lands before waitForIdle settles", async () => {
		const { host, session } = makeAdapterHarness();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		session.beforeEmit = () => gate;
		const handle = await host.createLeafSession(adapterLeafSpec());
		const pending = handle.prompt("hi");
		await handle.abort();
		release();
		await assert.rejects(pending, /Leaf prompt failed/);
		await handle.dispose();
	});

	it("contains listModels and dispose failures", async () => {
		const broken = makeAdapterHarness({}, { listThrows: true });
		assert.throws(
			() => broken.host.listModels(),
			(error: unknown) => error instanceof LeafFailure && error.code === "provider_error",
		);
		const { host, session } = makeAdapterHarness({ throwOnDispose: true });
		const handle = await host.createLeafSession(adapterLeafSpec());
		await handle.dispose();
		assert.equal(session.disposeCalls, 1);
	});

	it("treats any truthy shim marker as a shim (not just === true)", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-shim-proof-"));
		const root = join(scratch, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0-shim", main: "dist/index.js" }),
		);
		writeFileSync(join(root, "dist", "index.js"), "export default {};\n");
		const probed = await probeRealLeafHost({
			resolutionBase: join(root, "dist", "index.js"),
			load: async () => ({ __piSubagentsTestShim: 1 }),
		});
		assert.equal(probed, null);
	});
});
