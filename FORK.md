# Fork policy

This repo is a fork of [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)
(maintained at `rhinos0608/Pi-Subagents`, remote `origin`; upstream remote is `upstream`).

The fork diverges at the model-facing **surface and guidance** layer and carries measured
runtime-internal edits alongside it (115 src files changed vs merge-base; executor/runner
internals carry fork runtime edits), while keeping the model-visible contract small so
syncing stays reviewable. Small tool in, full engine inside:
the model sees 9 fields and 6 actions; Fleet, slash commands, and RPC keep the rest.

## Divergence principles

1. Small model-facing tool: 9 top-level fields (`agent`, `task`, `action`, `id`, `message`,
   `topic`, `workflowScript`, `args`, `cwd`; `src/extension/schemas.ts`), 6 model-callable actions
   (`steer`, `resume`, `interrupt`, `status`, `guide`, `validate`;
   `MODEL_VISIBLE_SUBAGENT_ACTIONS` in `src/shared/types.ts`), strict 10-field workflow child
   allowlist (`agent`, `task`, `cwd`, `resume`, `as`, `phase`, `label`, `lane`, `index`, `worktree`;
   `WORKFLOW_CHILD_ALLOWED_FIELDS` in `src/workflows/scripted-workflow.ts:1919`).
   `args` is workflowScript-only (frozen plain-JSON global, persisted as evidence — never
   secrets); `worktree` is a boolean (per-child isolation, clean tree required).
2. Management lives in Fleet, slash commands, and RPC — not the model tool. The other 49 of the
   55 `SUBAGENT_ACTIONS` stay routable internally but are not model-visible.
3. Execution policy (model, thinking, budgets, timeouts, skills, placement) comes from agent
   definitions and operator config, not per-call fields.
4. Always fresh context: every child starts empty; the parent puts files, constraints, and
   success criteria in `task`.
5. Model-facing guidance describes mechanisms and tradeoffs, not delegation policy. Operators
   set policy in their own instructions. Genuine safety invariants stay (safety kernel in
   `src/extension/tool-description.ts`).
6. Verbatim rules from `src/extension/tool-description.ts` (`EXECUTION_GUIDANCE`):
   - Anti-monolithic: "Do not hand one subagent a monolithic task; stage work sequentially
     or fan out across independent seams/files."
   - Concurrent-writer: "When writers may touch overlapping files: if git status is clean, give
     each writer its own managed worktree (`worktree: true` on its workflow child); otherwise
     give each writer disjoint file ownership — unless the user restricted work to one writer
     per cwd."

## Upstream sync procedure

1. `git fetch upstream`; confirm `upstream/main` and latest tag.
2. Snapshot: `git branch backup/pre-upstream-<upstream-tag>-<YYYYMMDD>` (existing pattern:
   `backup/pre-upstream-v0.70.0-20260920`, `backup/pre-upstream-v0.71.0-20260926`).
3. Triage every upstream-only commit TAKE / ADAPT / SKIP; record in `docs/fork-delta.md`.
4. Apply TAKE items oldest-first on an integration branch; re-implement ADAPT items on the
   fork surface with trailer `Upstream: <hash>`.
5. Run `npm run typecheck` and `npm test`; compare failing test names with the pre-sync baseline.
6. Merge into the working branch; update the ledger's "last synced" line in `docs/fork-delta.md`.

## Triage defaults

- TAKE: runtime/internal bugfixes, security, performance, test-stability, CI, MCP /
  model-resolution and worktree fixes.
- ADAPT: commits touching fork-rewritten surface files (`schemas.ts`, `public-execution.ts`,
  `tool-description.ts`, `subagent-executor.ts` dispatch, `scripted-workflow.ts` validation,
  `index.ts` registration).
- SKIP: removed features (`subagents_enable` activation, `bg_wait`, provider-override layer,
  fork context, compact/full description modes), upstream release/version/changelog bumps,
  features that re-expand the model-facing surface — unless the owner approves.

## Surface-change rule

Any new model-facing field, action, or workflow child field needs an owner decision, an entry
in `docs/fork-delta.md`, and a test in `test/unit/public-boundary-contract.test.ts`.
Prefer operator config or agent frontmatter instead.

## Versioning and publishing

Decision (2026-09-29, owner): the fork publishes as `@rhinos0608/pi-subagents` (scoped,
`publishConfig: public`, no `private` flag), version `0.71.0` kept. Upstream keeps
`pi-subagents`, so the names no longer collide. The release workflow
(`.github/workflows/release.yml`, manual dispatch, publishes `./dist-pkg` with provenance)
is guarded to `rhinos0608/Pi-Subagents`. Owner-only publish checklist: 1) confirm an npm
user/org owns the `rhinos0608` scope; 2) choose the next version; 3) add the `NPM_TOKEN`
repo secret (or npm trusted publishing for OIDC); 4) optionally add a maintainer-approval
environment; 5) merge to main and tag; 6) dispatch Release and verify provenance;
7) smoke `pi install npm:@rhinos0608/pi-subagents` after removing upstream. Migration:
installs move to the scoped name; host import specifiers `pi-subagents/...` become
`@rhinos0608/pi-subagents/...`.

## Contributing back

Fixes to shared internals that are not fork-specific can be offered upstream as PRs.
