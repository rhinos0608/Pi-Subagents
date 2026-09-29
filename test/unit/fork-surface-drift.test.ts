import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MODEL_VISIBLE_SUBAGENT_ACTIONS } from "../../src/shared/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VISIBLE = new Set<string>([...MODEL_VISIBLE_SUBAGENT_ACTIONS]);

const DENY = /\b(subagents_enable|bg_wait|defaultSubagentContext|defaultContext|forkContext|workflowScriptPath)\b/;
const REMOVAL_MARK = /remov/i;
const ABSENCE_ASSERTION = /there is no/i;
const REMOVED_SECTION = /^#+\s+.*\(removed\)/i;
const CHANGELOG_CUTOFF = /^##\s+\[/;

const DENYLIST_EXEMPT_FILES = new Set([
	"docs/fork-delta.md",
	"docs/subagent-tooling-overhaul.md",
	"docs/fork-decisions.md",
]);

function walkMarkdown(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkMarkdown(full, out);
		else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
	}
	return out;
}

function corpusFiles(): string[] {
	const files: string[] = [];
	for (const dir of ["docs", "skills", "prompts"]) {
		const full = path.join(ROOT, dir);
		if (fs.existsSync(full)) files.push(...walkMarkdown(full));
	}
	for (const file of ["README.md", "src/extension/tool-description.ts"]) {
		files.push(path.join(ROOT, file));
	}
	return files;
}

function unreleasedOnly(rel: string, lines: string[]): string[] {
	if (rel !== "CHANGELOG.md") return lines;
	const out: string[] = [];
	for (const line of lines) {
		if (CHANGELOG_CUTOFF.test(line) && !line.includes("[Unreleased]") && out.length > 0) break;
		out.push(line);
	}
	return out;
}

describe("fork surface drift guard", () => {
	it("names no removed knob as a live token in model-facing docs", () => {
		const violations: string[] = [];
		for (const full of corpusFiles()) {
			const rel = path.relative(ROOT, full);
			if (DENYLIST_EXEMPT_FILES.has(rel)) continue;
			let inRemovedSection = false;
			const lines = unreleasedOnly(rel, fs.readFileSync(full, "utf-8").split("\n"));
			lines.forEach((line, index) => {
				if (REMOVED_SECTION.test(line)) inRemovedSection = true;
				else if (/^#+\s+/.test(line)) inRemovedSection = false;
				if (inRemovedSection) return;
				if (REMOVAL_MARK.test(line)) return;
				if (ABSENCE_ASSERTION.test(line)) return;
				const hit = line.match(DENY);
				if (hit) violations.push(`${rel}:${index + 1}: ${hit[1]}`);
			});
		}
		assert.deepEqual(violations, []);
	});

	it("shows no callable subagent example outside the 6 visible actions", () => {
		const bad: string[] = [];
		const files = [...corpusFiles(), path.join(ROOT, "src/agents/advertised-agent-prompt.ts")];
		for (const full of files) {
			const rel = path.relative(ROOT, full);
			if (DENYLIST_EXEMPT_FILES.has(rel)) continue;
			const text = fs.readFileSync(full, "utf-8");
			const lines = rel === "CHANGELOG.md" ? unreleasedOnly(rel, text.split("\n")) : text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (!line.includes("subagent(") || line.includes("subagent_supervisor(")) continue;
				const match = line.match(/action\s*:\s*"([^"]+)"/);
				if (match && !VISIBLE.has(match[1]!)) bad.push(`${rel}:${i + 1}: ${match[1]}`);
			}
		}
		assert.deepEqual(bad, []);
	});

	it("matches the advertised catalog limits in docs to the source constants", () => {
		const src = fs.readFileSync(path.join(ROOT, "src/agents/advertised-agent-prompt.ts"), "utf-8");
		const agents = Number(src.match(/MAX_ADVERTISED_AGENTS\s*=\s*(\d+)/)?.[1]);
		const catalog = Number(src.match(/MAX_CATALOG_BYTES\s*=\s*([\d_]+)/)?.[1]?.replace(/_/g, ""));
		const description = Number(src.match(/MAX_DESCRIPTION_BYTES\s*=\s*(\d+)/)?.[1]);
		assert.ok(agents > 0 && catalog > 0 && description > 0);
		const docs = fs.readFileSync(path.join(ROOT, "docs/agents.md"), "utf-8");
		assert.match(docs, new RegExp(`limited to ${agents} agents`));
		assert.match(docs, new RegExp(`\\b${catalog.toLocaleString("en-US")}\\b`));
		assert.match(docs, new RegExp(`capped at ${description} UTF-8 bytes`));
	});

	it("names no non-visible action in model-facing prompt text", () => {
		for (const rel of ["src/extension/tool-description.ts", "src/agents/advertised-agent-prompt.ts"]) {
			const text = fs.readFileSync(path.join(ROOT, rel), "utf-8");
			const found = [...text.matchAll(/action\s*:\s*\\?"([a-z][\w.-]*)\\?"/g)].map((m) => m[1]!);
			assert.ok(found.length > 0, `${rel} should contain action references`);
			assert.deepEqual(found.filter((a) => !VISIBLE.has(a)), []);
		}
	});
});
