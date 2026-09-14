/**
 * Bounded leaf run manager: state machine, server-side concurrency, result
 * retention, timeouts, and bounded cancellation settlement.
 *
 * States: running -> completed | failed | cancelled. No other transitions;
 * an illegal transition trips the health breaker (permanent `unhealthy`:
 * no new starts, existing status/result/cancel stay readable).
 */
import { randomUUID } from "node:crypto";
import {
	RUNTIME_RPC_BOUNDS,
	RUNTIME_RPC_ERROR_MESSAGES,
	type RuntimeCancelSettlement,
	type RuntimeRunState,
	type RuntimeStartV1,
} from "../../api/runtime-rpc.ts";
import { executeLeafRun, LeafFailure, type LeafHost } from "./leaf-model-session.ts";

export type RuntimeErrorCode =
	| "runtime_unavailable"
	| "unsupported_capability"
	| "capacity_exceeded"
	| "not_found"
	| "invalid_state"
	| "invalid_params"
	| "model_unavailable"
	| "provider_error"
	| "timeout"
	| "output_token_limit_exceeded"
	| "result_byte_limit_exceeded"
	| "output_contract_breach"
	| "contract_breach";

export class RuntimeError extends Error {
	readonly code: RuntimeErrorCode;
	constructor(code: RuntimeErrorCode, message?: string) {
		super(message ?? RUNTIME_RPC_ERROR_MESSAGES[code as keyof typeof RUNTIME_RPC_ERROR_MESSAGES] ?? code);
		this.name = "RuntimeError";
		this.code = code;
	}
}

interface RunRecord {
	runId: string;
	state: RuntimeRunState;
	startedAt: number;
	updatedAt: number;
	output?: string;
	outputTokens?: number;
	errorCode?: RuntimeErrorCode;
	retainedBytes?: number;
	abort: () => Promise<void>;
	settled: Promise<void>;
	expiredTimer?: ReturnType<typeof setTimeout>;
}

export interface LeafRuntimeOptions {
	host: LeafHost | null;
	cwd: string;
	now?: () => number;
	/** Test seam replacing real leaf execution. */
	execute?: (input: { modelId: string; prompt: string; maxOutputTokens: number; cwd: string }) => Promise<{
		output: string;
		outputTokens: number;
	}>;
	onStateChange?: (runId: string, state: RuntimeRunState) => void;
}

function leafCodeToRuntime(code: string): RuntimeErrorCode {
	switch (code) {
		case "model_unavailable":
			return "model_unavailable";
		case "unsupported_capability":
			return "unsupported_capability";
		case "invalid_params":
			return "invalid_params";
		case "output_token_limit_exceeded":
			return "output_token_limit_exceeded";
		case "output_contract_breach":
			return "output_contract_breach";
		default:
			return "provider_error";
	}
}

export class LeafModelRuntime {
	private readonly options: LeafRuntimeOptions;
	private readonly runs = new Map<string, RunRecord>();
	private runningCount = 0;
	private retainedBytes = 0;
	private unhealthy = false;
	private readonly now: () => number;

	constructor(options: LeafRuntimeOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	get isUnhealthy(): boolean {
		return this.unhealthy;
	}

	get activeRuns(): number {
		return this.runningCount;
	}

	/** Binds the probed host after async verification; fail-closed until set. */
	setHost(host: LeafHost | null): void {
		this.options.host = host;
	}

	private requireAvailable(): void {
		if (this.options.host === null) throw new RuntimeError("runtime_unavailable");
		if (this.unhealthy) throw new RuntimeError("contract_breach");
	}

	private tripBreaker(): void {
		this.unhealthy = true;
	}

	/** Central transition owner: validates, releases the slot exactly once. */
	private transition(record: RunRecord, next: Exclude<RuntimeRunState, "running">): void {
		if (record.state !== "running") {
			this.tripBreaker();
			throw new RuntimeError("contract_breach");
		}
		record.state = next;
		record.updatedAt = this.now();
		this.runningCount -= 1;
		try {
			this.options.onStateChange?.(record.runId, next);
		} catch {
			// Consumer callback failures never propagate through transition.
		}

	}

	start(params: RuntimeStartV1): { runId: string; state: "running" } {
		this.requireAvailable();
		if (params.outputSchema !== undefined) throw new RuntimeError("unsupported_capability");
		if (this.runningCount >= RUNTIME_RPC_BOUNDS.maxParallelRuns) throw new RuntimeError("capacity_exceeded");
		const promptBytes = Buffer.byteLength(params.prompt, "utf8");
		if (promptBytes > RUNTIME_RPC_BOUNDS.maxPromptBytes) throw new RuntimeError("invalid_params");
		// Synchronous reservation: slot held before the detached promise starts.
		const runId = `runtime_${randomUUID().replace(/-/g, "")}`;
		let abortFn: () => Promise<void> = async () => {};
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		const record: RunRecord = {
			runId,
			state: "running",
			startedAt: this.now(),
			updatedAt: this.now(),
			abort: () => abortFn(),
			settled,
		};
		this.runs.set(runId, record);
		this.runningCount += 1;
		void this.runLeaf(record, params, {
			setAbort: (fn) => {
				abortFn = fn;
			},
			done: () => resolveSettled(),
		});
		return { runId, state: "running" };
	}

	private async runLeaf(
		record: RunRecord,
		params: RuntimeStartV1,
		hooks: { setAbort: (fn: () => Promise<void>) => void; done: () => void },
	): Promise<void> {
		const host = this.options.host;
		const execute = this.options.execute;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		// Abort handle exists before execution so cancel races settle safely.
		const abortState = { aborted: false, sessionAbort: async () => {} };
		hooks.setAbort(async () => {
			abortState.aborted = true;
			await abortState.sessionAbort();
		});
		const finish = (next: Exclude<RuntimeRunState, "running">, extra?: Partial<RunRecord>) => {
			if (timeout) clearTimeout(timeout);
			Object.assign(record, extra);
			try {
				this.transition(record, next);
			} catch {
				// Breaker already tripped; run stays accounted.
			}
			this.scheduleRetentionExpiry(record);
			hooks.done();
		};
		let work!: Promise<{ output: string; outputTokens: number }>;
		try {
			work = (async () => {
				if (execute) return execute({ modelId: params.modelId, prompt: params.prompt, maxOutputTokens: params.maxOutputTokens, cwd: this.options.cwd });
				if (!host) throw new LeafFailure("provider_error", "No host.");
				// Wire abort into the session when the real host supports it.
				return executeLeafRun(
					{
						hostVersion: host.hostVersion,
						listModels: () => host.listModels(),
						createLeafSession: async (spec) => {
							const session = await host.createLeafSession(spec);
							abortState.sessionAbort = () => session.abort();
							return session;
						},
					},
					{ modelId: params.modelId, prompt: params.prompt, maxOutputTokens: params.maxOutputTokens, cwd: this.options.cwd },
				);
			})();
			const timeoutWork = new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					timedOut = true;
					void abortState.sessionAbort().catch(() => {});
					reject(new RuntimeError("timeout"));
				}, params.timeoutMs);
				timeout.unref?.();
			});
			const outcome = await Promise.race([work, timeoutWork]);
			const totalBytes = Buffer.byteLength(JSON.stringify({ output: outcome.output, outputTokens: outcome.outputTokens }), "utf8");
			if (totalBytes > RUNTIME_RPC_BOUNDS.maxResultBytes) {
				finish("failed", { errorCode: "result_byte_limit_exceeded" });
				return;
			}
			if (this.retainedBytes + totalBytes > RUNTIME_RPC_BOUNDS.retainedResultMemoryBytes) {
				finish("failed", { errorCode: "result_byte_limit_exceeded" });
				return;
			}
			this.retainedBytes += totalBytes;
			record.retainedBytes = totalBytes;
			finish(timedOut ? "cancelled" : "completed", { output: outcome.output, outputTokens: outcome.outputTokens });
		} catch (error) {
			if (timedOut || (error instanceof RuntimeError && error.code === "timeout")) {
				// Slot stays reserved until provider work actually settles: await
				// the aborted work so orphan execution never frees concurrency.
				// Hung work keeps the run `running`; cancelAndSettle then trips
				// the breaker with contract_breach instead of false settlement.
				try {
					await work!;
				} catch { /* aborted work rejection is expected */ }
				finish("cancelled", { errorCode: "timeout" });
				return;
			}
			if (error instanceof LeafFailure) {
				finish("failed", { errorCode: leafCodeToRuntime(error.code) });
				return;
			}
			if (error instanceof RuntimeError) {
				finish("failed", { errorCode: error.code });
				return;
			}
			finish("failed", { errorCode: "provider_error" });
		}
	}

	private scheduleRetentionExpiry(record: RunRecord): void {
		if (record.expiredTimer) clearTimeout(record.expiredTimer);
		record.expiredTimer = setTimeout(() => {
			const retained = record.retainedBytes ?? 0;
			this.retainedBytes = Math.max(0, this.retainedBytes - retained);
			this.runs.delete(record.runId);
		}, RUNTIME_RPC_BOUNDS.resultRetentionMs);
		record.expiredTimer.unref?.();
	}

	status(runId: string): { runId: string; state: RuntimeRunState; startedAt: number; updatedAt: number } {
		if (this.options.host === null) throw new RuntimeError("runtime_unavailable");
		const record = this.runs.get(runId);
		if (!record) throw new RuntimeError("not_found");
		return { runId, state: record.state, startedAt: record.startedAt, updatedAt: record.updatedAt };
	}

	result(runId: string): { runId: string; state: "completed"; output: string; outputTokens: number; truncated: boolean } {
		if (this.options.host === null) throw new RuntimeError("runtime_unavailable");
		const record = this.runs.get(runId);
		if (!record) throw new RuntimeError("not_found");
		if (record.state === "running") throw new RuntimeError("invalid_state");
		if (record.state !== "completed") throw new RuntimeError(record.errorCode ?? "provider_error");
		return { runId, state: "completed", output: record.output ?? "", outputTokens: record.outputTokens ?? 0, truncated: false };
	}

	/**
	 * Bounded settlement: validate all IDs before side effects, abort running
	 * sessions concurrently, await one shared deadline. Every run accounts
	 * exactly once or the breaker trips with `contract_breach`.
	 */
	async cancelAndSettle(runIds: string[], settlementWindowMs: number): Promise<{ settlements: RuntimeCancelSettlement[] }> {
		if (this.options.host === null) throw new RuntimeError("runtime_unavailable");
		for (const runId of runIds) {
			if (!this.runs.has(runId)) throw new RuntimeError("not_found");
		}
		const deadline = this.now() + settlementWindowMs;
		// Bounded abort phase: hung abort() must not stall past the deadline.
		// Unsettled runs trip the breaker below via the per-run wait.
		await Promise.race([
			Promise.allSettled(
				runIds.map((runId) => {
					const record = this.runs.get(runId);
					if (record?.state === "running") return record.abort().catch(() => {});
					return Promise.resolve();
				}),
			),
			new Promise((resolve) => {
				const timer = setTimeout(resolve, Math.max(0, deadline - this.now()));
				timer.unref?.();
			}),
		]);
		const settlements: RuntimeCancelSettlement[] = [];
		for (const runId of runIds) {
			const record = this.runs.get(runId);
			if (!record) {
				this.tripBreaker();
				throw new RuntimeError("contract_breach");
			}
			if (record.state === "running") {
				const remaining = deadline - this.now();
				if (remaining <= 0) {
					this.tripBreaker();
					throw new RuntimeError("contract_breach");
				}
				const settled = await Promise.race([
					record.settled.then(() => true),
					new Promise<false>((resolve) => {
						const timer = setTimeout(() => resolve(false), remaining);
						timer.unref?.();
					}),
				]);
				if (!settled) {
					// Slot stays reserved; hung work is never falsely settled.
					this.tripBreaker();
					throw new RuntimeError("contract_breach");
				}
			}
			const terminal = record.state;
			if (terminal === "running") {
				this.tripBreaker();
				throw new RuntimeError("contract_breach");
			}
			settlements.push({ runId, state: terminal });
		}
		return { settlements };
	}

	/** Bounded async shutdown for lifecycle barriers. */
	async shutdown(settlementWindowMs = RUNTIME_RPC_BOUNDS.maxSettlementWindowMs): Promise<void> {
		const running = [...this.runs.values()].filter((record) => record.state === "running");
		await Promise.allSettled(running.map((record) => record.abort().catch(() => {})));
		const deadline = this.now() + settlementWindowMs;
		for (const record of running) {
			const remaining = deadline - this.now();
			if (remaining <= 0) break;
			await Promise.race([
				record.settled.catch(() => {}),
				new Promise((resolve) => {
					const timer = setTimeout(resolve, remaining);
					timer.unref?.();
				}),
			]);
		}
		for (const record of this.runs.values()) {
			if (record.expiredTimer) clearTimeout(record.expiredTimer);
		}
	}
}
