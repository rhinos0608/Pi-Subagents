/**
 * `subagents:runtime:v1` event bridge. Separate namespace; legacy
 * `subagents:rpc:v1` behavior untouched.
 *
 * Readiness gate: no ready event and `runtime_unavailable` for every routable
 * request while the host is unverified (test shim, unlisted version, or null
 * host probe). Host upgrades fail closed until allowlisted.
 */
import { createHash } from "node:crypto";
import {
	RUNTIME_RPC_BOUNDS,
	RUNTIME_RPC_ERROR_MESSAGES,
	RUNTIME_RPC_PROTOCOL,
	RUNTIME_RPC_READY_EVENT,
	RUNTIME_RPC_REQUEST_EVENT,
	RUNTIME_RPC_VERSION,
	runtimeRpcReplyEvent,
	type RuntimeRpcErrorCode,
	type RuntimeRpcMethod,
	type RuntimeRpcReply,
	type RuntimeRpcV1Request,
} from "../api/runtime-rpc.ts";
import { safeRuntimeRequestId, validateRuntimeRequest } from "./runtime-rpc-schemas.ts";
import { isVerifiedHostVersion } from "../runs/runtime/leaf-model-session.ts";
import { LeafModelRuntime, RuntimeError } from "../runs/runtime/leaf-model-runtime.ts";
import { resolveExactModel } from "../runs/runtime/leaf-model-session.ts";

interface EventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

export interface RuntimeRpcBridgeOptions {
	events: EventBus;
	runtime: LeafModelRuntime;
	/** Installed host version string; unverified values keep the gate closed. */
	hostVersion: string;
	now?: () => number;
	/** Environment override for tests; defaults to process.env. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Explicit opt-out kill switch for the runtime bridge (single source of truth).
 * Absent/empty (anything other than exact `"1"`) keeps the bridge enabled by
 * default; exact `"1"` skips registration/ready/request handling entirely.
 */
export const RUNTIME_RPC_DISABLE_ENV_VAR = "PI_SUBAGENTS_RUNTIME_RPC_DISABLED";

export function isRuntimeRpcDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[RUNTIME_RPC_DISABLE_ENV_VAR] === "1";
}

interface IdempotencyRecord {
	digest: string;
	reply: RuntimeRpcReply;
	expiresAt: number;
}

/** Prior runtime still settling blocks new readiness. Module-global barrier. */
let priorSettling: Promise<void> | null = null;

export function markRuntimeSettling(settled: Promise<void>): void {
	priorSettling = settled;
	void settled.finally(() => {
		if (priorSettling === settled) priorSettling = null;
	});
}

export function isRuntimeSettling(): boolean {
	return priorSettling !== null;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key]);
		return sorted;
	}
	return value;
}

function stableDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonicalize(value)) ?? "null").digest("hex");
}

export function isRuntimeGateOpen(hostVersion: string): boolean {
	if (isRuntimeSettling()) return false;
	return isVerifiedHostVersion(hostVersion);
}

function errorReply(requestId: string, method: RuntimeRpcMethod | undefined, code: RuntimeRpcErrorCode): RuntimeRpcReply {
	return {
		version: RUNTIME_RPC_VERSION,
		requestId,
		...(method ? { method } : {}),
		success: false,
		error: { code, message: RUNTIME_RPC_ERROR_MESSAGES[code] },
	};
}

export function registerRuntimeRpcBridge(options: RuntimeRpcBridgeOptions): {
	emitReady: () => Promise<void>;
	dispose: () => Promise<void>;
} {
	// Explicit opt-out: skip registration/ready/request handling entirely.
	if (isRuntimeRpcDisabled(options.env ?? process.env)) return { emitReady: async () => {}, dispose: async () => {} };
	const now = options.now ?? Date.now;
	const seen = new Map<string, IdempotencyRecord>();
	// Synchronous in-flight reservation: concurrent duplicate requestIds join
	// one dispatch instead of double-executing runtime.start.
	const inFlight = new Map<string, { digest: string; reply: Promise<RuntimeRpcReply> }>();

	const prune = () => {
		const at = now();
		for (const [key, record] of seen) {
			if (record.expiresAt <= at) seen.delete(key);
		}
		while (seen.size > RUNTIME_RPC_BOUNDS.maxIdempotencyRecords) {
			const oldest = seen.keys().next();
			if (oldest.done) break;
			seen.delete(oldest.value);
		}
	};

	const dispatch = async (request: RuntimeRpcV1Request): Promise<RuntimeRpcReply> => {
		const requestId = request.requestId;
		const method = request.method;
		const ok = (data: unknown): RuntimeRpcReply => ({
			version: RUNTIME_RPC_VERSION,
			requestId,
			method,
			success: true,
			data,
		});
		try {
			switch (request.method) {
				case "negotiate": {
					// Breaker is authoritative: tripped runtime never advertises
					// capabilities, even when the host version is allowlisted.
					if (options.runtime.isUnhealthy) throw new RuntimeError("contract_breach");
					const host = (options.runtime as unknown as { options?: { host?: unknown } }).options?.host;
					const models = typeof host === "object" && host !== null && "listModels" in host
						? (host as { listModels(): Array<{ fullId: string; provider: string; id: string; api?: string; maxTokens?: number; contextWindow?: number }> }).listModels()
						: [];
					const model = resolveExactModel(request.params.modelId, models);
					// Effective max is min(server ceiling, model max). Prior
					// negotiation is not authorization; start repeats all checks.
					const maxOutputTokens = Math.min(RUNTIME_RPC_BOUNDS.maxNegotiatedOutputTokens, model.maxTokens);
					const minOutputTokens = model.api === "openai-responses" ? RUNTIME_RPC_BOUNDS.minResponsesOutputTokens : 1;
					// Fail closed: a model whose max sits below the API minimum
					// cannot advertise an impossibly inverted token range.
					if (maxOutputTokens < minOutputTokens) throw new RuntimeError("unsupported_capability");
					return ok({
						compatible: true,
						modelId: request.params.modelId,
						capabilities: {
							boundedCancellationSettlement: true,
							leafOnlyExecution: true,
							exactModelSelection: true,
							maxOutputTokensEnforced: true,
							backgroundExecution: true,
							maxParallelRuns: RUNTIME_RPC_BOUNDS.maxParallelRuns,
							maxResultBytes: RUNTIME_RPC_BOUNDS.maxResultBytes,
							minOutputTokens,
						maxOutputTokens,
							outputModes: ["text"],
						},
					});
				}
				case "start":
					return ok(options.runtime.start(request.params));
				case "status":
					return ok(options.runtime.status(request.params.runId));
				case "result":
					return ok(options.runtime.result(request.params.runId));
				case "cancelAndSettle":
					return ok(await options.runtime.cancelAndSettle(request.params.runIds, request.params.settlementWindowMs));
			}
		} catch (error) {
			if (error instanceof RuntimeError) return errorReply(request.requestId, request.method, error.code);
			const { LeafFailure } = await import("../runs/runtime/leaf-model-session.ts");
			if (error instanceof LeafFailure) {
				const code: RuntimeRpcErrorCode =
					error.code === "model_unavailable"
						? "model_unavailable"
						: error.code === "unsupported_capability"
							? "unsupported_capability"
							: error.code === "output_token_limit_exceeded"
								? "output_token_limit_exceeded"
								: error.code === "output_contract_breach"
									? "output_contract_breach"
									: "provider_error";
				return errorReply(request.requestId, request.method, code);
			}
			return errorReply(request.requestId, request.method, "provider_error");
		}
		// Unreachable: method union exhaustive. Fail closed if reached.
		return errorReply(requestId, method, "unsupported_method");
	};

	const unsubscribe = options.events.on(RUNTIME_RPC_REQUEST_EVENT, (raw) => {
		void (async () => {
			const validated = validateRuntimeRequest(raw);
			if (!validated.ok) {
				const requestId = safeRuntimeRequestId(raw);
				// Missing/unsafe requestId cannot route safely: ignore, no side effects.
				if (!requestId) return;
				const code = validated.code === "unsupported_version" ? "unsupported_version" : validated.code;
				options.events.emit(runtimeRpcReplyEvent(requestId), errorReply(requestId, undefined, code));
				return;
			}
			const request = validated.value;
			prune();
			const digest = stableDigest({ method: request.method, params: request.params });
			const prior = seen.get(request.requestId);
			if (prior && prior.expiresAt > now()) {
				if (prior.digest === digest) {
					options.events.emit(runtimeRpcReplyEvent(request.requestId), prior.reply);
					return;
				}
				options.events.emit(runtimeRpcReplyEvent(request.requestId), errorReply(request.requestId, request.method, "duplicate_request_id"));
				return;
			}
			// Concurrent duplicates join the in-flight dispatch; digest
			// collisions reject without executing twice.
			const flying = inFlight.get(request.requestId);
			if (flying) {
				if (flying.digest !== digest) {
					options.events.emit(runtimeRpcReplyEvent(request.requestId), errorReply(request.requestId, request.method, "duplicate_request_id"));
					return;
				}
				options.events.emit(runtimeRpcReplyEvent(request.requestId), await flying.reply);
				return;
			}
			let resolveFlight!: (reply: RuntimeRpcReply) => void;
			const flightReply = new Promise<RuntimeRpcReply>((resolve) => {
				resolveFlight = resolve;
			});
			inFlight.set(request.requestId, { digest, reply: flightReply });
			try {
				// Gate: closed host returns runtime_unavailable, never executes.
				if (!isRuntimeGateOpen(options.hostVersion)) {
					const reply = errorReply(request.requestId, request.method, "runtime_unavailable");
					seen.set(request.requestId, { digest, reply, expiresAt: now() + RUNTIME_RPC_BOUNDS.idempotencyTtlMs });
					resolveFlight(reply);
					options.events.emit(runtimeRpcReplyEvent(request.requestId), reply);
					return;
				}
				const reply = await dispatch(request);
				seen.set(request.requestId, { digest, reply, expiresAt: now() + RUNTIME_RPC_BOUNDS.idempotencyTtlMs });
				prune();
				resolveFlight(reply);
				options.events.emit(runtimeRpcReplyEvent(request.requestId), reply);
			} finally {
				inFlight.delete(request.requestId);
			}
		})().catch(() => {
			// Replies carry safe codes only; transport failures stay silent.
		});
	});

	return {
		emitReady: async () => {
			const settling = priorSettling;
			if (settling) {
				try {
					await settling;
				} catch {
					// Settlement outcome never blocks readiness; gate recheck decides.
				}
			}
			if (!isRuntimeGateOpen(options.hostVersion)) return;
			options.events.emit(RUNTIME_RPC_READY_EVENT, {
				version: RUNTIME_RPC_VERSION,
				protocol: RUNTIME_RPC_PROTOCOL,
				methods: ["negotiate", "start", "status", "result", "cancelAndSettle"],
			});
		},
		dispose: async () => {
			if (typeof unsubscribe === "function") unsubscribe();
			seen.clear();
			inFlight.clear();
			const settling = options.runtime.shutdown();
			markRuntimeSettling(settling);
			await settling;
		},
	};
}
