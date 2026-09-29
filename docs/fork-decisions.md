# Fork decisions registry

Frozen ID map for every FORK / FORK-DORMANT marker. Read [FORK.md](../FORK.md) for policy;
this file records each decision, its rationale, and its reversal conditions.
Reversing a decision means editing its entry here with owner sign-off — never
silently unmarking code.

Marker form: `// FORK(FD-012): <reason>` on fork-changed code (reason = why, not what);
`// FORK-DORMANT(FD-015): <reason>` on kept-but-unreachable upstream code.
Code-sites lines below are candidates from seam reports; refresh when marking.

## FD-001 — Small strict model surface (9 fields / 6 actions)

- Status: KEEP. Date: 2026-09-29.
- Decision: model tool exposes 9 fields (`agent task action id message topic workflowScript args cwd`)
  and 6 actions (`steer resume interrupt status guide validate`).
- Rationale: VISION "Scope must earn size" + "Compose before inventing"; FORK.md divergence principle 1.
- Upstream: 82 top-level fields, 57 model-callable actions.
- Reversal: owner approval + surface-change rule (FORK.md entry + boundary test).
- Pinning: `test/unit/public-boundary-contract.test.ts`.
- Code sites: candidate; refresh when marking (`src/extension/schemas.ts`, `src/shared/types.ts`).

## FD-002 — Internal actions routable but hidden

- Status: KEEP. Date: 2026-09-29.
- Decision: other 51 of 57 `SUBAGENT_ACTIONS` stay routable internally (Fleet/slash/RPC);
  not model-visible.
- Rationale: VISION operator leverage with control; FORK.md principle 2 (management in Fleet/slash/RPC).
- Upstream: all 57 model-callable.
- Reversal: owner approval; each newly exposed action needs its own registry entry.
- Pinning: `test/unit/public-boundary-contract.test.ts`.
- Code sites: candidate; refresh when marking (`src/shared/types.ts`, `src/runs/foreground/subagent-executor.ts`).

## FD-003 — Workflow child allowlist

- Status: KEEP. Date: 2026-09-29.
- Decision: strict 10-field `WORKFLOW_CHILD_ALLOWED_FIELDS` (`agent task cwd resume as phase label lane index worktree`); no per-child execution knobs.
- Rationale: VISION "Compose before inventing"; FORK.md principle 1 (no per-child execution knobs).
- Upstream: loose validation (rejects only orchestration keys).
- Reversal: owner approval + boundary test update.
- Pinning: `test/unit/public-boundary-contract.test.ts`.
- Code sites: candidate; refresh when marking (`src/workflows/scripted-workflow.ts`).

## FD-004 — Worktree child

- Status: KEEP (restored 2026-09-29). Date: 2026-09-29.
- Decision: per-child `worktree: true/false` restored on workflow children; `baseRef`/isolation stay rejected.
- Rationale: isolation is orchestration intent, not execution tuning (fork-delta owner decision 1).
- Upstream: per-call worktree knobs.
- Reversal: owner approval; record in `docs/fork-delta.md`.
- Pinning: `test/unit/public-boundary-contract.test.ts`.
- Code sites: candidate; refresh when marking (`src/workflows/scripted-workflow.ts`, `src/runs/shared/worktree.ts`).

## FD-005 — Frozen args

- Status: KEEP (restored 2026-09-29). Date: 2026-09-29.
- Decision: top-level `args` for `workflowScript` only; frozen plain-JSON global, ≤16 KiB, persisted as evidence, never secrets.
- Rationale: reuse scripts with different inputs without widening per-child surface (fork-delta owner decision 2).
- Upstream: bounded JSON `args` for inline/file/scheduled scripts.
- Reversal: owner approval.
- Pinning: `test/unit/public-boundary-contract.test.ts`.
- Code sites: candidate; refresh when marking (`src/workflows/workflow-resources.ts`).

## FD-006 — Operator policy + fresh context

- Status: KEEP. Date: 2026-09-29.
- Decision: execution policy (model, thinking, budgets, timeouts, skills, placement) from agent
  definitions + operator config, never per-call fields; every child starts fresh, parent passes
  context in `task`.
- Rationale: VISION "Authority comes from clarity"; FORK.md principles 3–4.
- Upstream: per-call model/provider overrides; `context: fresh|fork|profile`.
- Reversal: owner approval per knob restored.
- Pinning: `test/unit/pi-subagents-policy-guidance.test.ts`, `test/unit/tool-description.test.ts`.
- Code sites: candidate; refresh when marking (`src/agents/agents.ts`, `src/extension/tool-description.ts`).

## FD-007 — No activation / bg_wait

- Status: KEEP. Date: 2026-09-29.
- Decision: `subagents_enable` activation and `bg_wait` tool removed; tool always registered, always-async + completion wake.
- Rationale: VISION "Compatibility is explicit" (hard cutover, no shims); FORK.md triage SKIP class.
- Upstream: `tool-activation.ts`, `bg_wait` tool, `async` toggle.
- Reversal: owner approval; rejected by default.
- Pinning: `test/unit/fork-always-on.test.ts` (registers subagent with no activation step; no subagents_enable/bg_wait).
- Code sites: candidate; refresh when marking (`src/extension/index.ts`).

## FD-008 — Default description

- Status: KEEP. Date: 2026-09-29.
- Decision: single always-on default description (~2.2 KB); `default`/`custom` modes only;
  legacy `full`/`compact` render default with deprecation warning.
- Rationale: VISION token cost is a product constraint; FORK.md principle 5 (mechanisms, not policy).
- Upstream: `full`/`compact` description modes.
- Reversal: owner approval.
- Pinning: `test/unit/tool-description.test.ts`.
- Code sites: candidate; refresh when marking (`src/extension/tool-description.ts`).

## FD-009 — Fork RPCs

- Status: KEEP. Date: 2026-09-29.
- Decision: fork-only `result` RPC method + fork-only `subagents:runtime:v1` leaf runtime RPC kept.
- Rationale: finished-run result query + portable bounded leaf execution; operator visibility (VISION "Background work stays visible").
- Upstream: absent (poll `status`).
- Reversal: owner approval; upstream equivalent would supersede.
- Pinning: `test/unit/runtime-rpc.test.ts`, `test/unit/runtime-rpc-contract.test.ts`.
- Code sites: candidate; refresh when marking (`src/extension/rpc.ts`, `src/api/runtime-rpc.ts`).

## FD-010 — outputSchema DEFERRED

- Status: DEFERRED (open surface decision). Date: 2026-09-29.
- Decision: per-child `outputSchema`/structured output stays out; agent frontmatter default only.
- Rationale: dynamic typed joins lost; restore on `runs.run` is candidate, not yet approved (fork-delta owner decision 3).
- Upstream: per-call schema+gate fields; agent inline `outputSchema` default.
- Reversal: owner approval defines the restore shape.
- Pinning: `test/unit/public-boundary-contract.test.ts` (rejection pinned).
- Code sites: candidate; refresh when marking (workflow child validation).

## FD-011 — Scoped package

- Status: KEEP. Date: 2026-09-29.
- Decision: fork publishes as `@rhinos0608/pi-subagents` (scoped, public), version `0.71.0` kept;
  release workflow guarded to `rhinos0608/Pi-Subagents`.
- Rationale: names no longer collide with upstream `pi-subagents` (FORK.md versioning section).
- Upstream: `pi-subagents` name.
- Reversal: owner approval only.
- Pinning: `test/unit/host-peer-runtime-imports.test.ts` (import specifier surface).
- Code sites: candidate; refresh when marking (`package.json`, `.github/workflows/release.yml`).

## FD-012 — Executor surface translation lives at boundary

- Status: KEEP. Date: 2026-09-29.
- Decision: model-surface translation (narrow 9-field/6-action input → full internal launch)
  lives at the executor boundary, not scattered through runners.
- Rationale: FORK.md small-surface policy + hybrid rule (keep divergence at surface/boundary seams).
- Upstream behavior: no translation needed (model sees full surface).
- Reversal: owner approval.
- Pinning: `test/unit/public-boundary-contract.test.ts`, `test/unit/public-execution.test.ts`.
- Code sites: candidate; refresh when marking (`src/runs/foreground/subagent-executor.ts`).

## FD-013 — Executor context plumbing dormant

- Status: KEEP. Date: 2026-09-29.
- Decision: fork-context plumbing paths kept-but-unreachable where removal would churn shared code;
  always-fresh enforced at the boundary.
- Rationale: FORK.md hybrid rule (dormant over deletion where shared internals churn).
- Upstream behavior: `context: fork` carries parent history.
- Reversal: owner approval.
- Pinning: `test/unit/public-boundary-contract.test.ts`, `test/integration/fork-context-execution.test.ts`.
- Code sites: candidate; refresh when marking (executor context paths).

## FD-014 — No usage-budget surface

- Status: KEEP. Date: 2026-09-29.
- Decision: no per-call usage-budget fields; empty usage budgets rejected at schema admission;
  ceilings live in operator config.
- Rationale: FORK.md principle 3 (operator-owned budgets) + small-surface policy.
- Upstream behavior: per-call `usageBudget`/tool-budget knobs.
- Reversal: owner approval.
- Pinning: `test/unit/public-boundary-contract.test.ts`.
- Code sites: candidate; refresh when marking (schema admission, executor budget paths).

## FD-015 — Workflow dispatch dormant shape

- Status: KEEP. Date: 2026-09-29.
- Decision: upstream workflow dispatch shapes the fork does not expose are kept-but-unreachable
  in shared dispatch code rather than fork-deleted.
- Rationale: FORK.md hybrid rule (sync-cheap dormant shapes over risky deletions).
- Upstream behavior: wider child/step shapes dispatch.
- Reversal: owner approval.
- Pinning: `test/unit/public-boundary-contract.test.ts`, `test/unit/scripted-workflow.test.ts`.
- Code sites: candidate; refresh when marking (`src/workflows/` dispatch).

## FD-016 — Scheduled-owner execution

- Status: KEEP. Date: 2026-09-29.
- Decision: scheduled runs execute under owner-defined agent/config policy, not per-schedule
  model overrides.
- Rationale: FORK.md principle 3 (operator policy, not per-call fields).
- Upstream behavior: per-schedule execution knobs.
- Reversal: owner approval.
- Pinning: `test/unit/scheduled-runs.test.ts`.
- Code sites: candidate; refresh when marking (schedule launch paths).

## FD-017 — Exact run IDs

- Status: KEEP. Date: 2026-09-29.
- Decision: retained-child lookup uses exact run IDs; guidance states the retained list is not complete.
- Rationale: VISION "Evidence closes work" (no pretending a label is an identity).
- Upstream behavior: same lookup; fork guidance tightened.
- Reversal: owner approval.
- Pinning: `test/unit/subagent-action-recovery.test.ts`.
- Code sites: candidate; refresh when marking (retained/resume paths).

## FD-018 — Fleet resume

- Status: KEEP. Date: 2026-09-29.
- Decision: resume/stop/steer of owned runs stays in Fleet + slash commands, not the model tool
  (beyond the 6 visible actions).
- Rationale: FORK.md principle 2 (management lives in Fleet/slash/RPC).
- Upstream behavior: wider model-callable management surface.
- Reversal: owner approval + new registry entry per exposed action.
- Pinning: `test/unit/fleet-status.test.ts`, `test/unit/fleet.test.ts`.
- Code sites: candidate; refresh when marking (Fleet/slash resume paths).

## FD-019 — Runner terminal lifecycle dormant

- Status: KEEP. Date: 2026-09-29.
- Decision: upstream runner terminal-lifecycle paths the fork does not drive stay dormant
  in shared runner code.
- Rationale: FORK.md hybrid rule (keep runtime internals syncable; diverge at surface).
- Upstream behavior: fuller lifecycle driven from model surface.
- Reversal: owner approval.
- Pinning: `test/unit/control-channel.test.ts`.
- Code sites: candidate; refresh when marking (runner lifecycle).

## FD-020 — Async-execution step-option restrictions

- Status: KEEP. Date: 2026-09-29.
- Decision: async-execution step options beyond the fork child allowlist stay rejected;
  no per-step model/thinking/timeout/skill fields.
- Rationale: FORK.md principles 1–3 (allowlist + operator policy).
- Upstream behavior: per-step execution options.
- Reversal: owner approval.
- Pinning: `test/unit/scripted-workflow.test.ts`, `test/unit/async-execution.test.ts`.
- Code sites: candidate; refresh when marking (async step validation).

## FD-021 — Foreground recovery/continuation

- Status: KEEP. Date: 2026-09-29.
- Decision: foreground recovery continues the retained child session on the same resolved model;
  provider failures never auto-select another model.
- Rationale: VISION authority clarity; no silent execution-mode switches.
- Upstream behavior: same recovery scope retained.
- Reversal: owner approval.
- Pinning: `test/unit/run-child-session.test.ts`, `test/unit/abort-recovery.test.ts`.
- Code sites: candidate; refresh when marking (recovery/continuation paths).
