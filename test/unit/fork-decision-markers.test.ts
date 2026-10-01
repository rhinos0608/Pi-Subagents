import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTRY = path.join(ROOT, "docs/fork-decisions.md");

// Entries with no pinning test yet. Removing an ID from this list requires
// adding the test first; adding one requires owner sign-off in the registry.
const MISSING_TEST_ALLOWLIST: Record<string, string> = {
};

function registryIds(): string[] {
	const text = fs.readFileSync(REGISTRY, "utf-8");
	return [...text.matchAll(/^## (FD-\d+)/gm)].map((m) => m[1]);
}

function registryTextFor(id: string): string {
	const text = fs.readFileSync(REGISTRY, "utf-8");
	const start = text.indexOf(`## ${id}`);
	assert.notEqual(start, -1, `registry entry ${id} exists`);
	const next = text.indexOf("\n## FD-", start + 1);
	return text.slice(start, next === -1 ? undefined : next);
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (/\.(ts|mts|js|mjs)$/.test(entry.name)) out.push(full);
	}
	return out;
}

describe("fork decision markers", () => {
	it("every FORK marker references a registry entry", () => {
		const ids = new Set(registryIds());
		assert.ok(ids.size > 0, "registry defines entries");
		const bad: string[] = [];
		for (const file of walk(path.join(ROOT, "src"))) {
			const text = fs.readFileSync(file, "utf-8");
			for (const m of text.matchAll(/FORK(?:-DORMANT)?\((FD-\d+)\)/g)) {
				if (!ids.has(m[1])) bad.push(`${path.relative(ROOT, file)}: ${m[1]}`);
			}
		}
		assert.deepEqual(bad, [], "all marker IDs exist in docs/fork-decisions.md");
	});

	it("every registry entry pins existing test files", () => {
		const missing: string[] = [];
		for (const id of registryIds()) {
			const entry = registryTextFor(id);
			const testPaths = [...entry.matchAll(/`(test\/[^`]+)`/g)].map((m) => m[1]);
			const hasMissing = entry.includes("**MISSING**");
			if (testPaths.length === 0 && !hasMissing) {
				missing.push(`${id}: no test path and no MISSING note`);
				continue;
			}
			for (const testPath of testPaths) {
				if (!fs.existsSync(path.join(ROOT, testPath))) missing.push(`${id}: ${testPath} does not exist`);
			}
			if (hasMissing && !(id in MISSING_TEST_ALLOWLIST)) {
				missing.push(`${id}: MISSING not in allowlist — add a test or get owner sign-off`);
			}
		}
		for (const [id, reason] of Object.entries(MISSING_TEST_ALLOWLIST)) {
			if (!registryTextFor(id).includes("**MISSING**")) {
				missing.push(`${id}: allowlisted as (${reason}) but registry no longer marks MISSING — remove from allowlist`);
			}
		}
		assert.deepEqual(missing, [], "registry pinning tests resolve");
	});
});
