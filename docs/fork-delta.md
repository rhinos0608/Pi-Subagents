# Fork delta ledger

Policy: [FORK.md](../FORK.md). This ledger records how the fork differs from upstream and the
triage state of unmerged upstream commits.

## Baseline (ledger date 2026-09-29)

Derived with:

- `git merge-base HEAD upstream/main` → `2e9c51bada2da6a9ba73b6973e1545a9afa0d057`
  (`2026-09-24`, subject `fix: tighten unreleased async lifecycle paths (#2479)`)
- `git show upstream/main:package.json` → version `0.73.1`; latest tag `v0.73.1`
  (`git tag --sort=-v:refname`)
- Fork `package.json` → name `pi-subagents`, version `0.71.0`
- `git rev-list --count HEAD..upstream/main` → **46 behind** (upstream/main `4416738f`, refetched
  2026-09-29; two commits past `v0.73.1`: `7c795dce`, `4416738f`)
- Per-commit cherry-pick simulation: `git merge-tree --write-tree --name-only --merge-base=<h>^ HEAD <h>`
  (each commit against HEAD independently; results do not account for earlier picks)

## Surface delta

Counts: upstream top-level fields = direct keys of `SubagentParamProperties`
(`upstream/main:src/extension/schemas.ts:280-400`, one-tab-indented `name:` lines) = 82,
including schedule/mission/workflow/watchdog knobs; fork = 9 (`Object.keys(SubagentParams.properties)`:
`agent task action id message topic workflowScript args cwd`).
Actions: `SUBAGENT_ACTIONS` has 57 entries in both trees; the fork keeps them routable internally
and exposes 6 to the model.

| Area | Upstream | Fork | Key files | Pinning tests | Rationale |
|---|---|---|---|---|---|
| Top-level tool fields | 82 (`SubagentParamProperties`, `upstream/main:src/extension/schemas.ts:280`) | 9: `agent task action id message topic workflowScript args cwd` (`src/extension/schemas.ts:238`) | `src/extension/schemas.ts`, `src/extension/public-execution.ts`, `src/runs/foreground/subagent-executor.ts` | `test/unit/public-boundary-contract.test.ts` | Small model surface; policy in config/agents |
| Model-callable actions | 57 (`SUBAGENT_ACTIONS`, `upstream/main:src/shared/types.ts`) | 6 (`MODEL_VISIBLE_SUBAGENT_ACTIONS`: steer/resume/interrupt/status/guide/validate, `src/shared/types.ts:2805`) | `src/shared/types.ts`, `src/runs/foreground/subagent-executor.ts` (executePublic gate) | `test/unit/public-boundary-contract.test.ts` | Management lives in Fleet/slash/RPC |
| Workflow child fields | loose (upstream rejects only orchestration keys) | strict 10-field allowlist (`WORKFLOW_CHILD_ALLOWED_FIELDS`, `src/workflows/scripted-workflow.ts:1919`: 9 prior + `worktree`) | `src/workflows/scripted-workflow.ts` | `test/unit/public-boundary-contract.test.ts:259` | No per-child execution knobs |
| `subagents_enable` activation | `src/extension/tool-activation.ts`, `bg_wait` tool | removed; tool always registered (`src/extension/index.ts`) | `src/extension/index.ts` | smoke tests removed | Always-on tool |
| Provider-override layer | per-call model/provider overrides | removed; flat `agentOverrides`, operator-owned models | `src/agents/agents.ts` | policy guidance tests | Operator owns model policy |
| Fork context | `context: fresh\|fork\|profile` | removed; always fresh context | `src/extension/tool-description.ts` | `test/unit/tool-description.test.ts` | Stateless; parent passes context in `task` |
| Compact/full description modes | `full`/`compact` modes | removed; `default`/`custom` only | `src/extension/tool-description.ts` | `test/unit/tool-description.test.ts` | One description + safety kernel |
| RPC `result` method | absent (poll `status`) | fork-only `result` (`src/extension/rpc.ts`, `RUNTIME_RPC_METHODS` in `src/api/runtime-rpc.ts:22`) | `src/extension/rpc.ts`, `src/api/runtime-rpc.ts` | RPC tests | Finished-run result query |
| `subagents:runtime:v1` | absent | fork-only leaf runtime RPC (`src/api/runtime-rpc.ts`, `src/extension/runtime-rpc.ts`) | `src/api/runtime-rpc.ts`, `src/extension/runtime-rpc.ts` | runtime RPC tests | Portable bounded leaf execution |
| Guidance | upstream delegation-authorization gate + policy-heavy docs | gate removed; guidance describes mechanisms/tradeoffs; writer rule + anti-monolithic rule as quoted in FORK.md; 9-field docs | `src/extension/tool-description.ts`, `docs/tool-reference.md`, `skills/pi-subagents/` | `test/unit/pi-subagents-policy-guidance.test.ts`, `test/unit/subagent-guide.test.ts` | Operators set policy |

## Removed capabilities and replacements

Based on the scout comparisons (`5c9e5dda…` top-level/action tables, `7ac7ed7a…` workflow/RPC
tables) with parent corrections applied.

| Capability | Upstream surface | Fork replacement | Load-bearing? |
|---|---|---|---|
| Per-call model/fast | `model`, `fast` fields | agent frontmatter + settings (`agentOverrides`) | No — operator-owned by design |
| Watchdog `thinking` knob | root `thinking` field (`schemas.ts:320`, watchdog-configure only) | operator config; not per-call | No — **not** a separate loss (parent correction) |
| Per-child reasoning `:level` | `model: "id:level"` suffix | operator-owned model config | No — intentionally removed |
| Per-child skills/budgets/timeouts | `skill`, `toolBudget`, `usageBudget`, `timeoutMs`, `maxRuntimeMs` | agent definitions + settings ceilings | No — intentionally removed |
| `context: fork` | fork parent history into child | parent dumps files/context into `task` | Ergonomics only; keep removed |
| `async` toggle + `bg_wait` | `async` field, `bg_wait` tool | always-async + completion wake | No loss |
| Chain/tasks/parallel JSON | legacy top-level pipelines | `workflowScript` (`runs.run`/`runs.all`) | No loss — strictly more expressive |
| Schedule/mission/watchdog/inspector actions | ~50 model actions | Fleet TUI, slash commands, RPC | No (operator domain) |
| `output`/`outputMode` file routing | per-call output fields | child writes files via task instruction | Minor; candidate restore on workflow child |
| `outputSchema`/acceptance/contract per call | per-call schema+gate fields | agent frontmatter; `runs.host` gates | Dynamic orchestration loss; candidate restore |
| `worktree`/`baseRef`/`isolation` flags | per-call worktree knobs | per-child `worktree: true/false` RESTORED on workflow children 2026-09-29; manual `cwd` path remains for single launches; `baseRef`/isolation stay rejected | Convenience loss; restored on workflow children |
| `args` on workflowScript | `args` params object | top-level `args` RESTORED 2026-09-29 (frozen plain-JSON global, 16 KiB limits) | Restored |
| Named `workflow` + `workflowScriptPath` | saved/file workflows | inline `workflowScript` only | No — keep removed |

## Owner decisions (2026-09-29)

1. Per-child worktree: `worktree: true/false` RESTORED on workflow children (10-field
   allowlist; boolean-checked at worker + static + runtime seams; `baseRef`/isolation/provider
   stay rejected). Rationale: isolation is orchestration intent, not execution tuning.
   `docs/subagent-tooling-overhaul.md:105` carries a dated amendment note.
2. Top-level `args` for `workflowScript`: RESTORED (frozen plain-JSON `args` global in the
   sandbox; total <= 16 KB with per-value/depth/width limits in
   `src/workflows/workflow-resources.ts`; persisted as evidence, never secrets).
3. Per-child `outputSchema`/structured output: DEFERRED (stays in Open decisions below).
4. Per-child model/thinking: KEPT REMOVED — a script chooses roles and semantics, not
   reasoning levels or models (operator-owned via agent definitions + config).
5. Upstream `c305d4bb` (model-scope scoped allow token): SKIP — model scoping stays retained
   operator config (triage table updated).
6. Package renamed to `@rhinos0608/pi-subagents` for npm publishing (scoped, public,
   `0.71.0` kept; release workflow guarded to `rhinos0608/Pi-Subagents`; publish checklist in
   FORK.md). Migration: installs use the scoped name; host import specifiers
   `pi-subagents/...` become `@rhinos0608/pi-subagents/...`.

## Open surface decisions (owner)

3. Per-child `outputSchema`/structured output — dynamic typed joins lost; restore on `runs.run`.
   (DEFERRED per 2026-09-29 decision.)
4. Per-child model/thinking — KEPT REMOVED (operator-owned).

## Pending upstream triage (46 behind)

Audited 2026-09-29 by five read-only reviewer passes (every commit diffed against fork code) with
parent spot-checks. Changes versus the first-pass ledger: `dbe82b62` ADAPT→SKIP (guard returns early
unless `contextPolicy.usesFork`; no `usesFork` in fork); `d5d3b9ff` ADAPT→TAKE (CHANGELOG-only
conflict); `4631d86b` ADAPT→TAKE (source applies, docs conflict only); `5983eab9` ADAPT→TAKE
(test-only); `1228ed68` TAKE→ADAPT (`index.ts` registration + TUI hot path, measure per VISION);
`4416738f` and `7c795dce` added. Owner decisions 2026-09-29: `6ecec9c3` SKIP (merge blockers on main
instead); `1228ed68` pull with render measurement; `4416738f` full ADAPT as last workflow phase;
`8dc90dca` TAKE (reverses the `docs/agents.md` statement that overrides cannot advertise).

| Hash | Subject | Verdict | Note |
|---|---|---|---|
| 32ceaab0 | fix(activation): accept stray subagents_enable arguments (#2492) | SKIP | removed activation |
| d556bb01 | fix(cost): include async single and chain child usage (#2490) | ADAPT | port artifact-based async usage scan; `subagent-cost.ts` conflicts |
| dbe82b62 | fix: enforce the capability ceiling before fork preparation (#2481) | SKIP | guard only runs for fork context, removed in fork |
| 2f37edbf | feat: support external inspector registration (#2482) | SKIP | also adds a host-extension API for external Fleet inspectors; no demand |
| 547ab8b6 | fix(models): resolve provider-prefixed catalog ids (#2491) | TAKE | CHANGELOG-only conflict |
| d3464c52 | perf: load the subagent executor and Fleet on first use (#2493) | ADAPT | `index.ts`/`slash-commands.ts` conflicts |
| d5d3b9ff | fix(async): scope runner liveness probes to the PID namespace (#2498) | TAKE | CHANGELOG-only; before `cbb2c099` |
| fadc560c | fix(watchdog): route helper model calls through the session registry (#2497) | TAKE | CHANGELOG-only |
| 6aac7a4a | chore: deslop unreleased changes (#2500) | SKIP | wording/test churn, no behavior fix |
| 2fe4e636 | test(deadline): give the short-lead checkpoint case the default result wait (#2501) | TAKE | clean |
| fe1b8988 | chore(release): v0.72.0 | SKIP | release bump |
| 6ecec9c3 | ci(release): require maintainer approval before publishing | SKIP | owner: merge blockers on main instead |
| fece3cea | chore(release): v0.72.1 | SKIP | release bump |
| 45da9e81 | ci: shorten the test workflow critical path (#2502) | TAKE | clean; do not bundle `13bf6b57` |
| 9f2e3416 | feat(workflows): label workflow failures with a kind (#2509) | ADAPT | executor conflicts; first in workflow chain |
| 4631d86b | fix(workflows): cap workflow result text and mark cut previews (#2508) | TAKE | docs conflicts only; after `9f2e3416` |
| 999890ed | fix(workflows): reject unknown literal agent names before child launch (#2507) | ADAPT | executor/test conflicts |
| d99a6f3f | fix(workflows): keep the saved full workflow result within artifact retention (#2510) | ADAPT | needs `4631d86b` full-result path |
| cc726ee7 | fix: resolve MCP direct tools from the adapter's mcp-adapter.json config (#2511) | TAKE | before `847ee4de` |
| 2f8c55a5 | fix(activation): tell the model when enabled tools arrive on bridged providers (#2514) | SKIP | removed activation |
| 1228ed68 | feat(tui): color running subagent spinners with Pi's thinking-level colors (#2512) | ADAPT | `index.ts` hookup; bundle `62b92bae` TUI hunks; measure render cost |
| 10015a31 | test(missions): give competing lock-recovery writers time to start on Windows (#2515) | TAKE | clean |
| 62b92bae | refactor: tidy the unreleased changes before release (#2516) | SKIP + hunks | port TUI per-row thinking dedupe with `1228ed68`; workflow tidy with workflow chain |
| 1852b449 | chore(release): v0.73.0 | SKIP | release bump |
| 5655f9bb | fix: reject oversized run timeouts (#2517) | ADAPT | guard retained config/agent timeout paths; before `b4dbd819` |
| e583ea6a | fix(agents): advertise subagents via a named prompt section (#2519) | ADAPT | prompt-section API; drop activation-test assumptions |
| 892475f1 | test(runner-bootstrap): poll startup state instead of fs.watchFile (#2520) | TAKE | clean |
| 4ac471bc | test: stop temp-root cleanup from failing passing Windows test files (#2521) | TAKE | clean |
| 5983eab9 | test(workflows): wait for durable async outcomes (#2522) | TAKE | test-only conflict |
| cbb2c099 | fix: reject stops after the runner stops reading them (#2523) | TAKE | `subagent-runner.ts` conflict; after `d5d3b9ff` |
| 8a403efb | chore(release): v0.73.1 | SKIP | release bump |
| 8dc5ce96 | feat: show new version highlights once after an upgrade (#2524) | SKIP | unwanted upgrade popups |
| 3bd1892f | fix(activation): let the model check its tool list after subagents_enable (#2525) | SKIP | removed activation |
| 1cf63c18 | fix: support older Git diff prefix options (#2527) | TAKE | high priority; fork `src/runs/shared/worktree.ts:23` still `--default-prefix` |
| 2f39ae2c | fix(activation): enable subagents_enable on in-process hosts (#2531) | SKIP | removed activation |
| 13bf6b57 | test: run tool activation smoke in CI (#2528) | SKIP | tests deleted feature |
| c8dd6556 | fix(supervisor): skip attention notices for answered supervisor requests (#2532) | TAKE | + control-notice tests from `7c795dce` |
| 8dc90dca | feat(agents): allow advertise through agentOverrides (#2534) | TAKE | operator config; update `docs/agents.md`; strip `defaultContext` from docs hunk |
| 847ee4de | fix: align MCP config hash with pi-mcp-adapter 3.1.0 (#2539) | TAKE | after `cc726ee7` |
| b4dbd819 | fix: recover child aborts when compaction starts late (#2537) | ADAPT | `run-child-session.ts`+`execution.ts` conflict |
| e24fe9c6 | fix(retention): reclaim async runs bound to terminal or pruned missions (#2536) | TAKE | + retention cleanup hunk from `7c795dce` |
| c305d4bb | feat(model-scope): add scoped allow token for Pi's scoped models (#2538) | SKIP | model scoping retained operator config (owner decision 2026-09-29) |
| 4cd43cae | fix(skills): drop extension skills when inheritSkills is false (#2541) | TAKE | docs conflict |
| 60905d10 | feat(config): let users turn off subagent features they don't use (#2543) | SKIP | contradicts permanent surface cut |
| 7c795dce | refactor: deslop unreleased changes (#2545) | SKIP + hunks | mostly skipped-feature cleanup; carry hunks with `e24fe9c6`, `c8dd6556` |
| 4416738f | feat(workflows): keep reload-stopped workflow work and reuse it on relaunch (#2547) | ADAPT | last workflow phase; must test reuse of `worktree: true` children |

Totals: 19 TAKE, 9 ADAPT, 18 SKIP.

Apply order:

1. TAKE batch: 2fe4e636, 45da9e81, 10015a31, 892475f1, 4ac471bc, 5983eab9, 1cf63c18, 547ab8b6,
   fadc560c, cc726ee7→847ee4de, 4cd43cae, 8dc90dca, c8dd6556 (+7c795dce tests), e24fe9c6
   (+7c795dce retention hunk), d5d3b9ff→cbb2c099.
2. Runtime ADAPT: d556bb01, 5655f9bb→b4dbd819, d3464c52, e583ea6a.
3. Workflow chain: 9f2e3416→4631d86b→d99a6f3f→999890ed (+62b92bae workflow hunks)→4416738f.
4. TUI: 1228ed68 (+62b92bae TUI hunks), gated on before/after render measurement.

## Last synced

Last integration 2026-09-29 on `merge/upstream-v0.73.1-20260929`: all 46 upstream commits behind
`2e9c51ba` triaged — 19 TAKE (cherry-pick `-x`), 9 ADAPT (+`62b92bae`/`7c795dce` companion
hunks, worktree-reuse guard in `matchWorkflowReuse`, fanout-child executor memoization), 18 SKIP.
Now at `upstream/main` `4416738f` (past `v0.73.1`). Kept divergence: `running-tone.test.ts`
retains the `"no level at all → accent"` case that upstream `62b92bae` cut (pinned to `1228ed68`).
