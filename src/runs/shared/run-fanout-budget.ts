import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	TEMP_ROOT_DIR,
	type RunFanoutBudgetDescriptor,
	type RunFanoutBudgetSnapshot,
	type RunFanoutRejection,
} from "../../shared/types.ts";

export const DEFAULT_MAX_SUBAGENT_SPAWNS_PER_RUN = 64;
export const RUN_FANOUT_BUDGET_ENV = "PI_SUBAGENT_RUN_FANOUT_BUDGET";
const RUN_FANOUT_ROOT = path.join(TEMP_ROOT_DIR, "run-fanout-budgets");

interface ManifestV1 {
	version: 1;
	rootRunId: string;
	limit: number;
	createdAt: number;
}

interface ClaimV1 {
	version: 1;
	claimId: string;
	path: string;
	claimedAt: number;
}

export class RunFanoutLimitError extends Error {
	readonly rejection: RunFanoutRejection;
	readonly snapshot: RunFanoutBudgetSnapshot;

	constructor(rejection: RunFanoutRejection) {
		super(formatRunFanoutRejection(rejection));
		this.name = "RunFanoutLimitError";
		this.rejection = rejection;
		this.snapshot = { used: rejection.used, limit: rejection.limit, remaining: rejection.remaining };
	}
}

function safeRootRunId(rootRunId: string): string {
	return rootRunId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || randomUUID();
}

function parseManifest(value: unknown): ManifestV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const manifest = value as Partial<ManifestV1>;
	if (manifest.version !== 1 || typeof manifest.rootRunId !== "string" || !manifest.rootRunId
		|| !Number.isInteger(manifest.limit) || (manifest.limit ?? 0) <= 0
		|| typeof manifest.createdAt !== "number" || !Number.isFinite(manifest.createdAt)) return undefined;
	return manifest as ManifestV1;
}

function readManifest(directory: string): ManifestV1 {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf-8"));
	} catch (error) {
		throw new Error(`Run fan-out budget manifest is unreadable at '${directory}': ${error instanceof Error ? error.message : String(error)}`);
	}
	const manifest = parseManifest(parsed);
	if (!manifest) throw new Error(`Run fan-out budget manifest is invalid at '${directory}'.`);
	return manifest;
}

function validateDirectory(directory: string): string {
	const resolved = path.resolve(directory);
	const root = path.resolve(RUN_FANOUT_ROOT);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error("Run fan-out budget directory is outside the managed budget root.");
	}
	return resolved;
}

export function createRunFanoutBudget(rootRunId: string, limit: number): RunFanoutBudgetDescriptor {
	if (!Number.isInteger(limit) || limit <= 0) throw new Error("Run fan-out limit must be a positive integer.");
	fs.mkdirSync(RUN_FANOUT_ROOT, { recursive: true, mode: 0o700 });
	let directory: string;
	do directory = path.join(RUN_FANOUT_ROOT, `${safeRootRunId(rootRunId)}-${randomUUID()}`);
	while (fs.existsSync(directory));
	fs.mkdirSync(path.join(directory, "claims"), { recursive: true, mode: 0o700 });
	const manifest: ManifestV1 = { version: 1, rootRunId, limit, createdAt: Date.now() };
	fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: "wx" });
	return { version: 1, rootRunId, directory, limit };
}

export function validateRunFanoutBudgetDescriptor(value: unknown): RunFanoutBudgetDescriptor {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Run fan-out budget descriptor is missing or invalid.");
	const descriptor = value as Partial<RunFanoutBudgetDescriptor>;
	if (descriptor.version !== 1 || typeof descriptor.rootRunId !== "string" || !descriptor.rootRunId
		|| typeof descriptor.directory !== "string" || !descriptor.directory
		|| !Number.isInteger(descriptor.limit) || (descriptor.limit ?? 0) <= 0
		|| (descriptor.parentPath !== undefined && typeof descriptor.parentPath !== "string")) {
		throw new Error("Run fan-out budget descriptor is invalid.");
	}
	const directory = validateDirectory(descriptor.directory);
	const manifest = readManifest(directory);
	if (manifest.rootRunId !== descriptor.rootRunId || manifest.limit !== descriptor.limit) {
		throw new Error("Run fan-out budget descriptor does not match its manifest.");
	}
	return { version: 1, rootRunId: descriptor.rootRunId, directory, limit: descriptor.limit, ...(descriptor.parentPath ? { parentPath: descriptor.parentPath } : {}) };
}

export function writeRunFanoutBudgetDescriptor(asyncDir: string, descriptor: RunFanoutBudgetDescriptor): void {
	const valid = validateRunFanoutBudgetDescriptor(descriptor);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "run-fanout-budget.json"), `${JSON.stringify(valid)}\n`, { mode: 0o600 });
}

export function readRunFanoutBudgetDescriptor(asyncDir: string | undefined): RunFanoutBudgetDescriptor | undefined {
	if (!asyncDir) return undefined;
	const descriptorPath = path.join(asyncDir, "run-fanout-budget.json");
	if (!fs.existsSync(descriptorPath)) return undefined;
	try {
		return validateRunFanoutBudgetDescriptor(JSON.parse(fs.readFileSync(descriptorPath, "utf-8")));
	} catch (error) {
		throw new Error(`Invalid persisted run fan-out budget '${descriptorPath}': ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function encodeRunFanoutBudgetDescriptor(descriptor: RunFanoutBudgetDescriptor): string {
	return Buffer.from(JSON.stringify(validateRunFanoutBudgetDescriptor(descriptor)), "utf-8").toString("base64url");
}

export function decodeRunFanoutBudgetDescriptor(encoded: string | undefined): RunFanoutBudgetDescriptor | undefined {
	if (!encoded) return undefined;
	try {
		return validateRunFanoutBudgetDescriptor(JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8")));
	} catch (error) {
		throw new Error(`Invalid inherited run fan-out budget: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const CLAIM_LOCK_WAIT_MS = 5_000;
const CLAIM_LOCK_RETRY_MS = 10;
const claimLockWaitArray = new Int32Array(new SharedArrayBuffer(4));

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function withClaimLock<T>(directory: string, callback: () => T): T {
	const lockPath = path.join(directory, "claim.lock");
	const token = randomUUID();
	const deadline = Date.now() + CLAIM_LOCK_WAIT_MS;
	while (true) {
		try {
			fs.mkdirSync(lockPath, { mode: 0o700 });
			fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, token })}\n`, { mode: 0o600 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let stale = false;
			try {
				const parsed = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8")) as Partial<{ pid: number }>;
				stale = Number.isInteger(parsed.pid) && (parsed.pid ?? 0) > 0 && !processIsAlive(parsed.pid!);
			} catch {
				try { stale = Date.now() - fs.statSync(lockPath).mtimeMs >= CLAIM_LOCK_WAIT_MS; } catch {}
			}
			if (stale) {
				const stalePath = path.join(directory, `claim.stale-${randomUUID()}`);
				try {
					fs.renameSync(lockPath, stalePath);
					fs.rmSync(stalePath, { recursive: true, force: true });
					continue;
				} catch (takeoverError) {
					if (!(["ENOENT", "EEXIST"] as Array<string | undefined>).includes((takeoverError as NodeJS.ErrnoException).code)) throw takeoverError;
				}
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for run fan-out admission lock at '${directory}'.`);
			Atomics.wait(claimLockWaitArray, 0, 0, CLAIM_LOCK_RETRY_MS);
		}
	}
	try { return callback(); }
	finally {
		try {
			const current = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8")) as Partial<{ token: string }>;
			if (current.token === token) fs.rmSync(lockPath, { recursive: true, force: true });
		} catch {}
	}
}

function claimCount(directory: string): number {
	const claimsDir = path.join(directory, "claims");
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(claimsDir, { withFileTypes: true }); }
	catch { return Number.POSITIVE_INFINITY; }
	return entries.filter((entry) => /^\d{6}\.json$/.test(entry.name)).length;
}

export function getRunFanoutBudgetSnapshot(descriptor: RunFanoutBudgetDescriptor): RunFanoutBudgetSnapshot {
	const valid = validateRunFanoutBudgetDescriptor(descriptor);
	const used = claimCount(valid.directory);
	if (!Number.isFinite(used)) return { used: valid.limit, limit: valid.limit, remaining: 0 };
	return { used, limit: valid.limit, remaining: Math.max(0, valid.limit - used) };
}

export function childRunFanoutBudget(descriptor: RunFanoutBudgetDescriptor, childPath: string): RunFanoutBudgetDescriptor {
	const [qualified] = qualifyRunFanoutPaths(descriptor, [childPath]);
	return { ...descriptor, parentPath: qualified };
}

export function qualifyRunFanoutPaths(descriptor: RunFanoutBudgetDescriptor, paths: string[]): string[] {
	const prefix = descriptor.parentPath?.trim();
	return paths.map((item) => prefix ? `${prefix}/${item}` : item);
}

export function claimRunFanoutBatch(descriptor: RunFanoutBudgetDescriptor, paths: string[]): RunFanoutBudgetSnapshot {
	const valid = validateRunFanoutBudgetDescriptor(descriptor);
	if (paths.length === 0) return getRunFanoutBudgetSnapshot(valid);
	const qualified = qualifyRunFanoutPaths(valid, paths);
	return withClaimLock(valid.directory, () => {
		const before = getRunFanoutBudgetSnapshot(valid);
		if (qualified.length > before.remaining) {
			throw new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT", path: qualified[before.remaining] ?? qualified[0]!, requested: qualified.length, ...before });
		}
		const created: string[] = [];
		try {
			for (const claimPath of qualified) {
				for (let slot = 0; slot < valid.limit; slot++) {
					const slotPath = path.join(valid.directory, "claims", `${String(slot).padStart(6, "0")}.json`);
					try {
						const fd = fs.openSync(slotPath, "wx", 0o600);
						try {
							const claim: ClaimV1 = { version: 1, claimId: randomUUID(), path: claimPath, claimedAt: Date.now() };
							fs.writeFileSync(fd, `${JSON.stringify(claim)}\n`, "utf-8");
						} finally { fs.closeSync(fd); }
						created.push(slotPath);
						break;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
						throw error;
					}
				}
			}
			return getRunFanoutBudgetSnapshot(valid);
		} catch (error) {
			for (const slotPath of created) {
				try { fs.unlinkSync(slotPath); } catch {}
			}
			throw error;
		}
	});
}

export function formatRunFanoutBudget(snapshot: RunFanoutBudgetSnapshot): string {
	return `Run fan-out: ${snapshot.used}/${snapshot.limit} used, ${snapshot.remaining} remaining`;
}

export function formatRunFanoutRejection(rejection: RunFanoutRejection): string {
	return `Run fan-out limit reached at ${rejection.path} (${rejection.used}/${rejection.limit} used; ${rejection.requested} requested, ${rejection.remaining} remaining). No children from this admission group were started. Start a new top-level run or raise config.maxSubagentSpawnsPerRun.`;
}
