# Subagent Tooling Overhaul — Orchestration Log

Durable record of binding decisions and progress for the 9-phase overhaul in
`docs/subagent-tooling-overhaul.md`. This file is orchestration state, not a
deliverable — it exists so decisions survive context compaction. Copy it into
new phase worktrees alongside the plan doc when useful context for that phase.

## Repo/worktree map

- Hub: `/Users/rhinesharar/pi-subagents-overhaul` (branch `overhaul/compact-subagent-tooling`, untouched)
- Per-phase worktrees: `/Users/rhinesharar/wt-phaseNN-<slug>`, branch `overhaul/phase-NN-<slug>`
- Integration checkpoints: `/Users/rhinesharar/wt-tierN-integration`, branch `overhaul/tierN-integration`
- **Known hazard**: `git stash` is a repo-wide shared ref, NOT per-worktree. Running it
  concurrently in two worktrees of this repo caused a real cross-contamination incident
  (Phase 4's worker's uncommitted stash pop swept in Phase 3's entire diff undetected until
  the orchestrator caught a self-report/actual-diff mismatch). **No worker may use `git stash`
  for anything, ever, in this task.**
- Each new worktree needs: `ln -s /Users/rhinesharar/pi-subagents/node_modules node_modules`
  and `cp .../pi-subagents-overhaul/docs/subagent-tooling-overhaul.md docs/` (the plan doc is
  untracked in the source repo, so `git worktree add` does not carry it — every worker/reviewer
  told to "read docs/subagent-tooling-overhaul.md" needs this copied in first, or they hit ENOENT).

## Tier / dependency graph (revised from oracle consult + user decisions)

Original plan's 9 phases do not map to 9 independent worktrees — `subagent-executor.ts`
(~5700 lines, complexity 3893) is touched by nearly every phase. Real tiering:

- **Tier 1** (parallel from `main`): Phase 1a (delivery/wake contract tests — assert
  behavior already true today), Phase 2 (delete `subagents_enable`), Phase 8 (delete
  provider-scoped override layer only, see below)
- **Tier 2** (parallel, based on Tier 1 integration): Phase 3 (delete `bg_wait` tool
  surface + new background-work wake routing), Phase 4 (stateless model selection,
  delete exclusion cache)
- **Tier 3** (solo): Phase 5 (now a deletion-heavy execution-policy simplification,
  see below — NOT the original plan's "build one resolved policy object")
- **Tier 4** (solo): Phase 6 (schema shrink + Phase 1b boundary-rejection tests)
- **Tier 5** (solo): Phase 7 (Fleet/TUI build-out + remove management actions)
- **Tier 6** (solo): Phase 9 (docs + dead-code sweep, last)

Phase 1 was split: 1a (async delivery/wake tests, already-true behavior) ships in Tier 1
as its own green PR; 1b (schema-rejection tests) folds into Phase 6's PR since those
assertions can only pass once the schema actually shrinks. Do not create a standalone
"Phase 1" PR that is red on its own.

## Binding decisions (in order made)

### Phase 8 scope (narrower than "remove the override architecture" sounds)
`BuiltinAgentOverrideConfig`/`agentOverrides` is not just a model-fallback override —
`disable`/`enable`/`reset` agent management (`agent-management.ts`) is implemented on
top of it. Decision: delete only the **provider-scoped** layer
(`agentOverridesByProvider`/`providerOverrides`/`selectProviderOverrides`) and any true
per-run override path; **keep** the flat user/project `agentOverrides` store as the one
remaining durable customization layer Fleet (Phase 7) builds on. Do NOT touch
`AgentContractOverride`/`agentContract` (unrelated per-call compatibility-version
concept, out of scope, belongs to Phase 6 if anywhere). **Status: done, verified, merged
into Tier 1 integration.**

### Phase 3 bg_wait resolution
The plan says delete the model-facing wait tool but "internal event watchers... may
remain where they are runtime implementation details." Decision: delete the `bg_wait`
tool registration/schema/config/guidance entirely; **keep** `waitForSubagents` as a
plain internal function called directly (not through tool dispatch) by
`auto-drain.ts` and any child runtime lacking a root notifier.

**New capability, explicitly authorized by user** (not scope creep): provider/background-work
items with no native completion notifier (`listBackgroundWorkWakeChannels()`, previously
only consumed inside the blocking `bg_wait` poll loop) needed a replacement wake path once
the blocking tool is gone. Extended `WaitSubscriptionManager`
(`src/runs/background/wait-subscriptions.ts`) — which already delivers native-style wakes
via `pi.events.on(channel, reconcile)` → `pi.sendMessage(..., {triggerTurn:true})` — to also
subscribe to dynamic provider wake channels and diff against a per-session active-items
baseline, firing exactly one wake per active→inactive transition. Reviewer found and fixed a
real race: a provider channel never subscribed before could miss its item's completion if
it went active→inactive before the first periodic reconcile tick; fixed by baselining
synchronously in `start()`/`restore()` rather than waiting for the timer. **Status: done,
verified (including the race-condition fix), merged into Tier 2 integration.**

### Phase 4 model-retry classification (found via review, not the original brief)
Reviewer found real bugs verified directly in code, both fixed:
1. `isAccountExhaustedFailure` returned `true` unconditionally in
   `isRetryableModelFailureAttempt`, **before** the `toolCount > 0` terminal check —
   meaning quota/billing errors bypassed the "no retry after task execution started"
   rule. Fixed: `toolCount > 0` now checked first, no carve-outs, matching the plan's
   explicit boundary text.
2. A broad `/no output/i` pattern in `RETRYABLE_MODEL_FAILURE_PATTERNS` let arbitrary
   application-level errors mentioning "no output" get misclassified as retryable
   startup failures. Fixed: narrowed to only the two canonical cold-start/empty-response
   strings via `isTransientNoOutputFailure`.
3. Factory/launch-exception classification (does a `childSessions.create()` throw enter
   the retry loop?) — traced and confirmed: yes it does, and that's **correct** (a
   session that never started has executed no task, so retry/advance is right per plan).
Also added dead-field cleanup per the "each phase cleans its own dead code" policy (see
below): removed `modelHealthScope` (write-side already gone; also deleted the
"tolerant read" compat path in `async-resume.ts`/`dynamic-fanout.ts`/`types.ts`/
`parallel-utils.ts` — no compat shims on this fork). **Status: done, verified, merged
into Tier 2 integration.**

### Project policy: no deferred cleanup to Phase 9
User directive: every phase must remove its own dead local branches/imports/fields/tests
as part of its own completion. Phase 9's sweep is for genuinely cross-cutting remnants
that can't be known until every phase's removal set is final — it is not a place to
compensate for a phase leaving its own known dead code behind. Applied retroactively to
Phase 4's `modelHealthScope` fields.

### Phase 5 — redefined scope (supersedes the plan doc's "Budgets"/"Phase 5" text for this area)
User made this decision directly, deliberately narrower and more aggressive than the
plan doc. **The plan doc's Phase 5/Budgets sections are NOT authoritative for this area —
this log is.**

Delete entirely:
- `TurnBudgetState`/`TurnBudgetOutcome` — was already `@deprecated`, dead for new runs,
  kept only for backward-compat reads of old status files. Kill the corpse completely,
  no compat reads (~12 files: types.ts, async-status.ts, async-job-tracker.ts,
  result-intercom.ts, notify.ts, result-watcher.ts, run-status.ts, subagent-executor.ts,
  nested-events.ts, process-signal.ts, run-history.ts + tests).
- `usageBudget` entirely — file, schema fields (`UsageBudgetOverride`/
  `UsageBudgetLimitOverride`), config, all call sites.
- Context-mode **choice** at both per-call AND per-agent level — every child always gets
  fresh context; no fork/profile option anywhere, for any party (caller or agent author).
  Only leave agent-definition context-adjacent fields alone if they control something
  genuinely orthogonal to the fresh/fork/profile choice itself.
- Complex timeout resolution (`resolveForegroundTimeout`, `resolveSingleAgentLaunchTimeout`,
  `resolveConfigDefaultTimeoutMs`, `DEFAULT_FOREGROUND_TIMEOUT_MS`, the async-vs-foreground
  default split) at both per-call AND per-agent level. Replaced by ONE flat
  operator-configurable default (`subagents.defaults.timeoutMs`, defaulting to 3,600,000ms
  / 1 hour), no override path anywhere. `checkpointBeforeDeadlineMs` goes too (only made
  sense paired with a per-call deadline). `toolTimeoutMs` (per-individual-tool-call safety
  deadline, 5min default) is a **different, narrower concept and stays untouched**.
- Per-call `skill` schema field (`SkillOverride`) — and its twin in `src/api/delegation.ts`'s
  `SubagentDelegationRequest`/`toSubagentDelegationExecutionParams`. Skills become entirely
  agent-definition/config-owned. No separate per-call `tools`/`excludeTools`/
  `subagentOnlyExtensions` field exists at the launch-call level to remove (confirmed —
  those only ever existed in agent definitions).

Keep:
- `toolBudget` stays in schema (the only execution-tuning field the model still sees),
  with a **floor of 40 on the effective hard cap, clamped (not rejected)** — rejecting
  would be "nasty in workflow scripts" per user. Clamp applies regardless of source
  (per-call/agent-config/config-default) via `validateToolBudgetConfig` in
  `tool-budget.ts`, EXCEPT when a caller explicitly opts in with `{minimumHard: 0}`
  (a real, pre-existing mechanism used by `allowZeroToolBudget` read-only/reviewer roles
  in `subagent-executor.ts:7080` and the delegation API in `delegation-request.ts:90`) —
  that opt-in must still allow a genuine zero-tool-budget agent, found and fixed after a
  reviewer-style self-check caught the regression.
- `worktree`/`isolation`/`baseRef`/`lane` schema fields — untouched.
- **Capability ceiling** (`src/runs/shared/capability-ceiling.ts`) — untouched. This is a
  security/authorization boundary, a different category from execution-tuning policy:
  `allowedTools`/`allowedAgents`/`denyExtensions`, registered per-session, expresses the
  *maximum* a parent may ever grant a child (never something a caller requests), audited
  via `SubagentCapabilityAudit`, and intersects down nesting chains so a grandchild can
  never exceed what its parent was bounded to.
- `agentContract`/`AgentContractOverride`, `acceptance`, `gate`, model selection/fallback
  (Phase 4's territory) — all unrelated, untouched.

**Status: in progress.** Sub-progress as of this writing:
- Tool-budget floor + clamp-not-reject + formatting cleanup: **done, verified** (commit
  `bcafbe58` on `overhaul/phase-05-resolved-policy`).
- **Important correction to earlier tracking**: that same early commit (`bcafbe58`,
  self-reported by the worker as just "tool budget category") actually ALSO already
  deleted the SCHEMA-LEVEL fields for `context`, `timeoutMs`, `maxRuntimeMs`,
  `checkpointBeforeDeadlineMs`, `usageBudget`, and `skill` from `SubagentParamProperties`
  in `extension/schemas.ts` and from `src/api/delegation.ts`'s `SubagentDelegationRequest`
  — confirmed directly by reading current file content. The worker's self-report
  undersold the actual scope of that commit. This means: **the schema surface for Phase 5
  is already fully at its target end-state** (only `toolBudget`, `toolTimeoutMs`,
  `worktree`/`isolation`/`baseRef`/`lane` remain among the fields this phase concerns).
  What's NOT yet done is the corresponding BACKEND deletion (usage-budget.ts file itself,
  `resolveAgentDefaultContextPolicy`/context-mode resolution logic,
  `resolveForegroundTimeout`/timeout resolution logic) and updating the tests that still
  assert the OLD schema shape existed (these are now failing, expectedly — not a
  regression from other work, just an incomplete migration).
- TurnBudgetState/TurnBudgetOutcome corpse deletion: **done, verified** (82 references
  across ~14 files in the end — more than the original ~12-file estimate; also found
  turn-budget display logic in `tui/fleet.ts`, `tui/render.ts`,
  `workflows/workflow-checklist.ts`, `workflows/workflow-settlement.ts` not in the
  original list). Commits `11bfaedf` + `a16e92b4`. Typecheck clean, zero remaining
  references except legitimate pre-existing "assert the dead field is safely ignored"
  tests (e.g. `test/integration/async-status.test.ts`'s "ignores legacy turn-budget
  fields in persisted status data", `test/integration/single-execution.part-2.test.ts`'s
  "ignores legacy turn-budget options" — these intentionally construct old-shaped data
  to prove it's harmlessly ignored, which is exactly the desired end state; do not touch
  them further).
- Remaining, confirmed via a fresh `npm run test:unit` run (21 failures, all pre-existing
  incomplete-migration artifacts, none caused by the turn-budget work):
  1. Delete `src/runs/shared/usage-budget.ts` entirely + all backend call sites
     (schema field already gone; only the implementation file/callers remain).
  2. Delete context-mode choice backend logic (`resolveAgentDefaultContextPolicy`,
     `resolveExplicitContextPolicy`, `AgentDefaultContextPolicy` in
     `subagent-executor.ts`; schema field already gone) — at both per-call AND
     per-agent level per the original decision.
  3. Delete complex timeout resolution backend logic (`resolveForegroundTimeout`,
     `resolveSingleAgentLaunchTimeout`, `resolveConfigDefaultTimeoutMs`,
     `DEFAULT_FOREGROUND_TIMEOUT_MS`; schema field already gone) and replace with the
     one flat `subagents.defaults.timeoutMs` config default (3,600,000ms), at both
     per-call AND per-agent level.
  4. Fix the now-stale tests in `test/unit/schemas.test.ts` ("includes context field and
     default precedence for fresh/fork execution mode", "includes root-only reported
     usage budget", "documents workflow timeout aliases and omits removed turn
     budgets") — rewrite to assert ABSENCE of these fields, following the same pattern
     as the already-existing "omits removed legacy and workflow-child-only fields" /
     "bg_wait is gone: no model-facing wait schema remains" tests in the same file.
  5. Fix tool-budget-floor fixture mismatches: "creates and updates agents with tool
     budgets", "resolves async step tool budgets with step over run over agent over
     config precedence", "uses agent tool budget before config default...", "uses
     config default when no step, run, or agent budget exists" — these tests likely use
     hard values below 40 and assert the old (pre-floor) exact value; update expected
     values to account for the 40-floor clamp.
  6. Fix delegation-related failures: "runs structured delegation through the concurrent
     executor and preserves literal text metadata", "public subagent delegation
     contract", "async runner execution" — likely reference the now-removed
     `context`/`timeoutMs`/`skill` fields on `SubagentDelegationRequest`.
  7. Full typecheck + test verification, final grep sweep for `usageBudget`, `context`
     mode branching, complex timeout resolution symbol names.
  8. Commit as its own commit (or a couple of commits — worker's call on
     granularity, but same file must not span an uncommitted gap of >1 category again).

## Execution notes / lessons learned this session

- **Model override policy**: used `openai-codex/gpt-5.6-luna` for the original Phase 5
  dispatch (user had said "spend extra verification budget" on this checkpoint). User
  later said **no more overrides** — reverted to default `worker` model
  (`opencode-go/muse-spark-1.3-contributor`) for everything after. The override did not
  obviously outperform the default on this task.
- **Observed failure pattern on large mechanical deletions**: the default model
  repeatedly stopped after completing exactly one bounded category per turn regardless
  of explicit "don't stop early, continue through everything" instructions — this
  appears to be how it paces long mechanical tasks, not a willingness problem. Adapted
  by orchestrator-driven category-by-category (and even file-by-file) resumption instead
  of expecting one continuous run to finish everything.
- **Bulk-edit risk**: two separate attempts at "grep across many files and delete
  the corpse" resulted in either (a) a broken bulk edit that was correctly
  self-reverted, or (b) reverting all work on hitting the FIRST downstream type error.
  Root-caused as the model treating "TypeScript shows an error at another usage site
  after I delete a shared field" as a failure signal rather than the expected/normal
  compiler-assisted reference-finding it actually is. Fix: explicit reframing
  ("downstream type errors are normal, fix forward, don't revert") plus an exact
  pre-computed ordered file list (orchestrator does the grep/reconnaissance, hands
  over a checklist) rather than "grep and delete everywhere" — this got real, correct,
  incremental progress (9/11 files clean).
- **Timeout**: default 30-minute timeout was insufficient for careful one-file-at-a-time
  work across ~12 files; extended to 60-90 minutes on resumes for this category. When a
  run times out mid-task with good partial progress, the orchestrator commits that
  verified-clean partial state itself before resuming, so progress is never at risk of
  being lost to a subsequent bad resume.
- **User directive: prefer fresh-context workers over resume, from this point forward.**
  Accumulated session context (especially after failed attempts/reverts/corrections)
  appears to slow workers down and make repeating mistakes more likely. New approach:
  dispatch fresh (`context: "fresh"`) workers for each new unit of work, with the current
  state (what's done/committed, what's left, exact file/line pointers) handed over
  explicitly in the task brief rather than relying on the worker's own memory of prior
  turns. Do not chain further `action: "resume"` calls on an existing run once its current
  in-flight turn completes, even if the task isn't finished — dispatch fresh instead.
- **Transient infra failures are not task failures**: saw one "opencode-go API error (504):
  Upstream response was not valid JSON" mid-edit, leaving a genuinely broken (not reverted)
  typecheck-red intermediate state. This is a provider outage, not a reasoning failure —
  the correct response is to retry/continue the exact same work (with the concrete
  typecheck error list handed over as a running start), not to change model or approach.
- **Reviewer tooling constraint** (user-confirmed, not a fluke): the `reviewer` agent
  profile behaves as read-only — no bash, no `git diff`, even when explicitly told bash
  is available and to use it. Adapted: orchestrator runs `git diff --stat`/full diffs
  itself and hands reviewers the **exact list of changed files** directly in the task
  prompt; reviewers do file-level adversarial reading (`read`/`grep`/`inspect`) against
  that list rather than trying to discover the diff themselves. Orchestrator does all
  execution-based verification (typecheck, test runs) itself rather than asking
  reviewers to run them.
- **Verify, don't trust, applies to workers' own self-reports too**: caught two cases
  where a worker's own completion report was factually wrong relative to the actual
  diff/behavior — (1) Phase 2 claimed a test failure was "pre-existing" based on a
  `git stash` that was a no-op (already committed, nothing to stash) — orchestrator
  re-verified against a true pristine checkout and found it was a real regression;
  (2) Phase 4's original brief claimed factory-launch exceptions don't enter the retry
  loop — traced independently and found the opposite was true (and correct per plan).
  Always independently verify claims about "pre-existing" behavior against a true
  clean baseline, not a stash-based check in a branch that's already committed.

## Phase 5 completion (integrated)

All runner-side sub-branches merged into `overhaul/phase-05-resolved-policy` (commits
`e8edf4b9` usageBudget, `9193197b` context/fork, `d975df86` timeout, merge commits
`3f6484b4` + `d0048a37`). Typecheck clean, full unit suite at known-flaky baseline
(13 failures, all pre-existing/environmental, zero new). Verified independently.

## Oracle checkpoint #2 (post-Phase-5, read-only review)

Findings (run 5a3bd7b8):
1. Phase 6 still fits next — no resolved-policy object needed (was proposed architecture,
   not prerequisite). Phase 6 must reject removed keys at BOTH seams: top-level
   `SubagentParams` lacks `additionalProperties:false`, and workflow `runs.run` validates
   selected fields but accepts other JSON keys. Phase 1b tests must cover both. Keep
   internal recovery params distinct from model-authored inputs. Fleet effective-policy
   display must use launch-time evidence, not recompute.
2. Phase 8 dependency satisfied for Phase 7 (flat agentOverrides remains). BUT sequencing
   problem: strict seven-field Phase 6 removes model-facing management BEFORE Phase 7
   supplies the operator replacement (current Fleet lacks Agents management view).
   Recommendation: front-load minimum operator management (Phase 7a) BEFORE the Phase 6
   cutover.
3. Phase 6 owns per-run `model`/`fast`/`thinking` removal, but tool schema alone is
   insufficient — `SubagentParamsLike` + launch paths still consume `params.model`;
   structured delegation (`api/delegation.ts`, `delegation-adapters.ts`) still accepts
   `model`/`thinking`. Must inventory every model-authored entry point including workflow
   children. Preserve recorded model identity/candidates for retry/resume. Note: agent
   definitions + flat overrides still hold model/fallback settings — different from
   original settings.json-only aspiration; don't mistake per-run-choice removal for
   completing provenance migration.
4. No VISION violation in approved decisions. Two honest deviations to document:
   retained flat overrides ≠ original "one definition, no override" target; Phase 5
   retains per-call budget/isolation until Phase 6 removes them. Also: "no retry after
   execution" tests should cover zero-tool-call task outcomes, not just toolCount>0.
5. Recommended order: finish 05a/05b/05c (done) → **7a** minimum Fleet Agents
   create/edit/delete + disable/enable/reset + run controls → **6** strict schema +
   workflow allowlist + delegation audit + 1b tests → **7b** Fleet run details
   (attempts, launch-time facts, delivery/attention, artifacts) → **9** docs sweep.

## Revised plan (pending owner approval)

- Phase 7a (NEW split): minimum Fleet Agents management view + run controls, built
  against existing internal functions, BEFORE schema cutover.
- Phase 6: strict seven-field schema + workflow-child allowlist + delegation audit +
  Phase 1b rejection tests (both seams).
- Phase 7b: Fleet run details (recorded attempts, launch-time facts, delivery/attention,
  artifacts/controls).
- Phase 9: docs + cross-cutting dead-code sweep, last.

## PR strategy (not yet executed)

Each phase becomes its own stacked PR in dependency order via `gh pr create`, targeting
`main` for Tier-1-independent phases and stacking on the prior tier's integration point
for dependent phases, for the user to review/merge/cherry-pick independently.

## Standing autonomy grant (owner directive)

For the rest of the run: make reasonable sequencing/technical decisions directly unless
something is (a) irreversible or destructive, (b) inconsistent with VISION, (c) likely
to create significant rework, or (d) changes the final intended behavior/API. Otherwise
keep moving, record deviation + rationale here, surface in checkpoint summaries.
(Owner noted a prior interruption for worktree ordering was unnecessary — nothing ships
without a PR anyway.)

## Phase 6 progress

Split into 4 concurrent branches off Phase-5 tip d0048a37: 06a schema (top-level
7-field + additionalProperties:false + compact-branching deletion + control-ID
validation), 06b workflow (child allowlist + strict runs.run rejection + spelling
collapse), 06c delegation (per-run model/thinking/timeout/context/skill/fast/outputMode
removal + legacy request alignment), 06d boundary tests (Phase 1b, new file only).

Deviations/decisions recorded:
- 06b cross-boundary fixes authorized (subagent-executor consumer lines, acceptance.ts
  chain-validation gut, workflow-graph L119+L209, index.ts renderCall trim): convergent
  deletions, git merge reconciles, verified after.
- Workflow spelling collapse (workflowScriptPath/workflow/args) done as boundary-cut
  (reject at public-execution normalize) with downstream loaders left dead-but-compiling
  for Phase 9's sweep — legitimate Phase-9 territory (unreachable code across unowned
  files), not sloppy exit. Downstream hit list recorded in worker report for Phase 9.
- 06b OVER-CUT found and corrected: committed allowlist dropped output/outputMode/
  reads/progress which were never in the plan's removal list (routing/topology, not
  tuning). Nested-control 39/39 on baseline vs failing on branch proved it. Restored.
- `async` per-child RESTORED (against a direct instruction to report-not-restore —
  process deviation, not substance deviation): worker demonstrated essentiality via
  supervisor-ask blocking semantics, and VISION explicitly blesses blocked-child →
  supervisor dialogue, which needs blocking semantics to exist. Plan's removal was
  conditional ("unless proven essential") — condition met with VISION-backed proof.
  Accepted with this rationale recorded.
- `fast` per-run removal confirmed in scope (06c): preflight caller-fast path is
  runtime-mode tuning, removed; agent-config fast kept as config-owned policy.
- 05c threading regression found via test-rewrite work: timeoutMs resolved but never
  forwarded to executeAsyncSingle in runAsyncPath (simple async singles lost their
  backstop entirely). Fixed (2-3 lines) + deadline-checkpoint tests rewritten to
  global-config setup, genuinely green 4/4. Resume-path deadline handling
  (resumeExternalJobFollowUp/resumeAsyncRun sites) left as-is: resumes should carry
  the ORIGINAL persisted deadlineAt, not mint a fresh 1h timeout — re-resolving on
  resume would wrongly extend deadlines. Flagged for integration verification
  (resume/revival tests must stay green there).

## Phase 6 integration + verification (tier4-integration, from d0048a37)

Merged 06a+06b+06c+06d + 5 integration-branch fixups:
- 8097c5e2 control-ID boundary test re-pointed at 06a's rejectMissingControlRunId
  (added missing `export`; was schema-Check-asserting-optional-id, could never pass).
- Static/dynamic allowlist parity (supervisor Option A): baseRef flagged statically too
  (validateStaticRunParams wired into validateWorkflowScript; stale ok:true baseRef
  expectations flipped to ok:false, test-only). runs.all skips `key` (runtime strips
  before validateRunCall); spreads/computed skipped as advisory.
- 850a5a64 stale dual-mode/message-text test updates (schemas/tool-description/
  supervisor-ask suites) — all stale-test-side, no production suspects.
- Delegation hang diagnosed: stale fixtures sending removed fields → invalid_request
  → STARTED/UPDATE never fire → `while...await tick()` spins forever. Fixed in
  delegation-api + prompt-template-bridge fixtures (17/17 and 6/6, exit 0, no src/).
  intercomBridge on structured-delegation API ruled legitimate-to-keep (operator
  surface; 5c2ad796 kept it in supportedFields deliberately).
- a5123e34 fallout resolutions: REAL src/ fixes — preflight now REJECTS removed
  per-run fields (unsupported_mode) instead of silently ignoring (the :303 gap:
  per-call model SUCCEEDED); rpc.ts stops validating internal/system RPC params
  against the model-facing 7-field schema (category error) + adds per-method
  status view/lines validation. Stale goldens/fixtures updated alongside.

Decisions corrected/clarified:
- Fork defaults (agent.defaultContext, global defaultSubagentContext, forkContext
  config) remain LIVE — only the MODEL's per-call choice was removed. Matches the
  target architecture (coordination config moves to settings/agent definitions);
  my "always fresh" shorthand in the Phase 5 brief was imprecise, 05b's actual
  implementation is the correct end-state. No scope gap.
- Open item for closeout: tool-description.ts prose still teaches removed spellings
  (workflowScriptPath, {workflow,args}, Model override, per-child worktree/baseRef)
  — CLOSED by 0cd319fc (prose rewritten to valid spellings, management docs untouched;
  note: timed-out run 6103d2d7 had done the rewrite uncommitted, successor kept it).
  — dedicated worker dispatched (test updates included).

Full-suite gate (3689 tests, chunks, orphans killed first): A 1132 0-fail; B 1306
9-fail all known-flaky; C 1251 8-fail all known-flaky. Typecheck clean throughout.
Phase 6 CLOSED.

## Phase 7 integration + verification (tier7-integration, from 0cd319fc)

WS-A run-details + WS-B agents-view merged clean (file-disjoint as designed).
WS-C model-surface removal (51d0f1e9): dispatch allowlist cut to
steer/resume/interrupt/status/guide/validate; implementations kept for
internal/slash/RPC/Fleet; slash rewired to executor.execute (Gap 1 approved);
Fleet interrupt-as-pause real via deliverInterruptRequest.
- Gap 2 verdict: Fleet resume = slot + report, NOT wired (needs executor-delegate
  plumbing at 2 construction sites + UI flow; >budget). ACCEPTED DEVIATION: resume
  stays model/slash-side (kept action, both surfaces work); Fleet slot reserved.
  Rationale recorded: capability preserved, no stub shipped, reversible.
- Follow-up fallout (all resolved): advertised-agent-refresh via slash bridge
  (Option C — no src, no weakening; confirmed no Gap-1 hole, all 6 manage actions
  route via slash); recovery suggestions trimmed to kept actions (stale, test-only).
- Full-suite gate (~3740 tests): only known-flaky failures (terminal-width etc.).
  Typecheck clean throughout. Phase 7 CLOSED.

## Review corrections (owner-ordered, supersedes prior calls)

- REVERSED 06b async-restore: model-authored async removed from runs.run/runs.all
  (prior blocking-semantics claim unproven; suites arbitrate). Decided alongside:
  output/outputMode/reads/progress also removed from model-authored children
  (topology vs tuning line; all resolve from agent defs/workflow defaults/config;
  reads-removal closes file-access widening). Final set: 9 keys. Exact-set test locks.
- REVERSED resume-deferral: real Fleet resume path ordered (full plumbing scope).
  Interrupt wired into Fleet input/UI. Component-level test (selection→run→delivery).
- Scheduled boundary: executeScheduled moves off executePublic to internal route on
  its isolated owner executor + bidirectional regression.
- Exact-ID: prefix fallback deleted from model/Fleet control path (exactOnly exists
  at resolveForegroundResumeTarget:976 — wire it); negative prefix tests;
  supervisor-channel prefix stays as the human surface (no new API).
- Architecture decisions (conscious, pre-Phase-9): (1) PERSIST compact resolved-
  policy snapshot at launch in status.json (plan demands visible effective policy);
  (2) KEEP flat agentOverrides as deliberate operator layer (one-section provenance).
## Review loop (rounds 1-2 of 8 allowed; converged)

- R1 (workers, 4 slices): 1 blocker (RPC manage dead behind gate), 5 majors
  (topic dropped, 3 doc-vs-code, workflow snapshot gap), 7 minors.
- F1 (4 workers, disjoint): all implemented + committed.
- R2 (dedicated `reviewer` agents, packet diffs, read-only): ALL FIXED, no new
  issues, 4x merge-OK. Slices dropped out. Loop closed early by convergence.
- Noted: reviewer agents are read-only/no-shell — pass diffs as files;
  verify every reviewer claim by execution before fixing.

## Engine probe (owner-ordered Option 1; async/output removal under test)

- Resume: FIXED (12-line nested-first routing; nested-control 39/39 + regression).
- Asks: 10-rep/arm matrix PROVED real differential (baseline 50/50 green,
  removal 0/50 red) — then engine probe proved PRODUCTION WORKS (mode-independent
  ask routing via shared channel dirs + owner poller); differential = mock-harness
  limits (in-process mocks can't run in async subprocess). 5 arbiter tests pinned
  to agent-definition defaultAsync (operator path, invariant intact). No engine
  change; awaitSupervisor parked; 9-key set stands.

## Final gate (owner-ordered; in progress)

- Clean worktree wt-final-gate at tier7 tip + `npm ci` (no symlinks).
- Full unit: 3762 tests, 21 fail = 11 known-flaky + 10 new (guide/description
  stale-text from 9a/R1A churn + 2 subprocess trace-firsts) — triage worker active.
- Integration suite: pending triage commit.

Phase 9 hit list (accumulated): downstream dead workflow-spelling loaders (06b);
dead-but-compiling boundary-cut remnants; global default-model settings have no
writer (hand-edit; document it); Fleet resume deferred (document model/slash path);
docs presenting children.list as model-callable (tool-reference.md:189,
skills execution-controls.md:106); compact/full schema doc cleanup.

## Finale: fork sweep, authority simplification, gate, PRs

- Fork B implemented (core + trim + orphans + badges): always-fresh coherent;
  removed keys fail loud (modelExclusions precedent); fixtures purged; digests re-pinned.
- Authority: settings subagents.allowedTools added, dumb intersect, host-ceiling
  re-homed, nested inheritance deleted, reviewer de-doctrined. Principle recorded:
  framework never infers permissions from roles/tool names; operators select
  capabilities; runtime enforces effect restrictions.
- node_modules symlink saga: tracked since 368cc548 caused repeat main-tree wipes
  (npm-in-symlinked-tree); purged from tier7 + final-gate; real installs everywhere.
- Final gate (clean tree, npm ci): unit 3735 (13 known-flaky only); integration
  1062 (part-2 environmental only, verified identical on base twice); typecheck clean.
- PRs (rhinos0608/Pi-Subagents, stacked): #2 tier1→main, #3 tier2→tier1,
  #4 phase-05→tier2, #5 tier4→phase-05, #6 tier7→tier4. Note: gh resolves to
  upstream by default — pass --repo explicitly.
