#!/usr/bin/env node
// Upstream triage helper: classifies each upstream-only commit as TAKE / ADAPT / SKIP
// per FORK.md triage defaults and prints a markdown table.
// Usage: node scripts/upstream-triage.mjs [upstream-ref]
// Output columns: hash, subject, verdict, conflicting files, reason.
// Classification uses the commit's own file list (git diff-tree); the
// "conflicting files" column comes from an independent cherry-pick
// simulation (git merge-tree against merge-base) and does not drive verdicts.
import { execFileSync } from "node:child_process";

const upstreamRef = process.argv[2] ?? "upstream/main";
const run = (args) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

const base = run(["merge-base", "HEAD", upstreamRef]);
const hashes = run([
  "log", "--no-merges", "--reverse", "--format=%H", `${base}..${upstreamRef}`,
]).split("\n").filter(Boolean);

// Fork-rewritten surface: changes here must be re-implemented, not cherry-picked.
const ADAPT_FILES = [
  "src/extension/schemas.ts",
  "src/extension/public-execution.ts",
  "src/extension/tool-description.ts",
  "src/extension/index.ts",
  "src/workflows/scripted-workflow.ts",
  "src/runs/foreground/subagent-executor.ts",
];
// Removed-feature areas the fork intentionally does not carry.
const SKIP_SIGNALS = [
  "tool-activation", "subagents_enable", "bg_wait", "bg-wait", "wait-tool",
  "provider-override", "provideroverride", "model-scope", "modelscope",
  "defaultcontext", "usesfork", "fork preparation", "capability ceiling",
  "scoped allow", "scoped models",
];
const SKIP_SUBJECT = /chore\(release\)|release bump|^v?\d+\.\d+\.\d+|disable.*subagent|turn off subagent/i;

function classify(subject, files) {
  const hay = `${subject}\n${files.join("\n")}`.toLowerCase();
  const nonTest = files.filter((f) => !f.startsWith("test/"));
  const versionOnly =
    nonTest.length > 0 &&
    nonTest.every((f) => f === "CHANGELOG.md" || f === "package.json" || f === "package-lock.json");
  if (SKIP_SUBJECT.test(subject) || versionOnly)
    return ["SKIP", "release/version bump only"];
  if (SKIP_SIGNALS.some((s) => hay.includes(s)))
    return ["SKIP", "touches removed fork feature (activation/bg_wait/provider-override/model-scope/fork-context)"];
  if (files.some((f) => ADAPT_FILES.includes(f)))
    return ["ADAPT", "touches fork-rewritten surface file"];
  return ["TAKE", "runtime/internal fix; no surface conflict"];
}

const rows = hashes.map((h) => {
  const subject = run(["log", "-1", "--format=%s", h]);
  const files = run(["diff-tree", "--no-commit-id", "--name-only", "-r", h])
    .split("\n").filter(Boolean);
  // Independent cherry-pick simulation: files that would conflict.
  let conflicts = [];
  let raw = "";
  try {
    raw = execFileSync("git", ["merge-tree", "--write-tree", "--name-only", `--merge-base=${h}^`, base, h], { encoding: "utf8" });
  } catch (e) { raw = e.stdout ?? ""; } // merge-tree exits nonzero when conflicts exist; names are still printed
  const lines = raw.split("\n");
  // Format: <tree-hash>, conflicting paths, blank line, then status messages.
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "") break;
    conflicts.push(lines[i].trim());
  }
  const [verdict, reason] = classify(subject, files);
  return { hash: h.slice(0, 8), subject, verdict, conflicts, reason };
});

console.log("| Hash | Subject | Verdict | Conflicting files | Reason |");
console.log("|---|---|---|---|---|");
for (const r of rows)
  console.log(`| ${r.hash} | ${r.subject} | ${r.verdict} | ${r.conflicts.join(", ") || "none"} | ${r.reason} |`);
