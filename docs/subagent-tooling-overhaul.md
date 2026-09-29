# Subagent Tooling Overhaul Plan

## Purpose

This overhaul deliberately reduces the public subagent surface now that the runtime is stable enough to support a much smaller contract.

The guiding question is:

> What does a parent/orchestrator model truly need to run delegated work end to end?

Anything outside that minimum boundary should move to one of three places:

- settings/config for execution policy
- Fleet/TUI for operator definition, management, observability, and intervention
- runtime internals for lifecycle, retries, delivery, persistence, and enforcement

The goal is not to remove useful capability. The goal is to stop exposing implementation detail and operator policy as model choices.

This is intentionally a breaking simplification. Prefer deletion over compatibility shims.

## Design principles

### 1. The model-facing tool is the orchestration data plane

The parent should be able to:

- launch a named subagent with a task
- choose a working directory when the task requires it
- express a workflow script when code is the best orchestration representation
- steer, resume, or interrupt an existing run

It should not redefine agents, choose models, tune budgets, select recovery policy, manage schedules, manipulate watchdogs, clean worktrees, or perform administrative operations.

### 2. Configuration owns policy

Execution policy is resolved before launch and presented to the model as facts, not choices.

Configuration owns model/fallback order, soft and hard budgets, timeout policy, concurrency, nesting limits, isolation defaults, context defaults, and retained tool/extension policy.

The model may be informed of policy. It may not raise or override it.

### 3. Fleet/TUI owns definition and administration

Agent creation and management belong in the TUI.

The model should not have create/update/delete/eject/enable/disable/reset/refine-style administration actions.

Fleet becomes the authoritative place to inspect and control active runs, including effective policy and fallback attempts.

### 4. Runtime owns lifecycle mechanics

The runtime owns child ownership, completion delivery, parent wakeups, retry/backoff, persistence, exact-once notification, budget enforcement, worktree lifecycle, and recovery bookkeeping.

These should not become tool parameters simply because the runtime supports them.

### 5. Prefer stateless, deterministic behavior

Avoid adaptive caches and hidden routing.

A fresh launch should behave according to current config and current provider/model availability, not historical failure state from an earlier launch.

## Target public tool boundary

The public subagent schema collapses to three modes.

### Launch

    subagent({
      agent: string,
      task: string,
      cwd?: string
    })

cwd stays model-facing because it is part of task intent, not runtime tuning. It is necessary for monorepos, cross-repo work, multiple checkouts, and workflows whose children operate in different directories.

Relative cwd values resolve from the parent request's effective cwd. Absolute paths remain subject to existing filesystem/security policy.

### Workflow

    subagent({
      workflowScript: string,
      cwd?: string
    })

Workflow scripts remain a first-class power tool for capable orchestrators. They compactly express topology, fanout, joins, conditional sequencing, and synthesis.

The workflow child API should itself be aggressively small:

    runs.run(key, {
      agent?: string,
      task?: string,
      cwd?: string,
      resume?: string
    })

A likely core workflow surface is:

- runs.run(...)
- runs.all(...)
- runs.steer(...)
- runs.interrupt(...)

Every additional workflow primitive must justify its presence from zero.

Workflow children must not regain model selection, budget tuning, timeout tuning, fast mode, arbitrary skill/tool overrides, or other execution-policy knobs.

> Note (2026-09-29, owner decision): per-child `worktree: true/false` was restored on workflow children — isolation is orchestration intent (which writers share a tree), not execution tuning. `baseRef` / `isolation` / provider overrides stay removed. Top-level `args` for `workflowScript` was likewise restored (frozen plain-JSON global, never secrets). Per-child `outputSchema` stays deferred; per-child model/thinking stay removed.

### Live control

    subagent({
      action: "steer" | "resume" | "interrupt",
      id: string,
      message?: string
    })

Rules:

- steer requires a message
- resume takes the follow-up instruction in message
- interrupt may optionally include a reason/context message
- exact run IDs are canonical targets everywhere

The public vocabulary should therefore be close to:

    agent
    task
    cwd
    workflowScript
    action
    id
    message
    topic // guide-only: subagent({ action: "guide", topic: "workflows" })

If workflow argument/data separation proves necessary, args can be considered separately. It should not survive automatically.

## Always-on subagents

Delete the activation ceremony.

Remove:

- subagents_enable
- activation-state selection for the main tool
- prompt guidance telling the model when/how to enable subagents
- tests and documentation whose only purpose is fresh-session activation

The subagent tool is always registered and available when the extension is loaded.

Authorization and behavioral boundaries belong in concise system/tool guidance, not in a separate model-visible activation transaction.

## Asynchronous lifecycle: launch, yield, wake

bg_wait is removed completely.

There is no replacement wait or polling tool.

The intended lifecycle is:

1. parent launches child
2. runtime records child ownership and completion recipient
3. launch returns immediately
4. parent continues independent work or ends its turn
5. child completes, fails, or needs attention
6. runtime delivers the event to the owning parent session
7. delivery triggers a new parent turn when required

The existing native completion notification path becomes the sole normal synchronization story.

Parent guidance should be explicit:

> Subagents run asynchronously. Do not poll or wait for completion. Continue work that does not depend on the child. If no independent work remains, end your turn. You will be woken automatically when the child completes, fails, or requires attention.

The launch receipt should repeat that behavior concisely.

This invariant must also hold for nested delegation. A child that launches a grandchild follows the same ownership and wake rules.

### Delete wait-tool surface

Remove:

- bg_wait registration
- SubagentWaitParams
- waitTool config
- wait-tool timeout config/environment handling
- child allowlisting/exemptions for bg_wait
- foreground/background guidance that recommends bg_wait
- wait-tool docs and tests
- polling-oriented recovery guidance

Internal event watchers, reconciliation, and headless shutdown/drain mechanisms may remain where they are runtime implementation details.

## Model selection: configured list, bounded retries, no cache

Model selection becomes stateless and deterministic.

### Operator-owned configuration

A subagent's model and ordered fallbacks are defined in settings.json. The model cannot override them per call.

Conceptually:

    {
      "subagents": {
        "agents": {
          "worker": {
            "models": [
              "openai-codex/gpt-5.6-sol:high",
              "anthropic/claude-opus-4-8"
            ]
          }
        }
      }
    }

The exact final key names can be chosen during implementation. One ordered models array is attractive because it directly represents the execution algorithm: first choice followed by ordered fallbacks.

There are no per-run model overrides, provider-scoped role overrides, or hidden runtime substitutions.

If an agent is unavailable because its configured candidates cannot be resolved or started, stop and report the failure. Do not invent another model or execution path.

### Retry algorithm

Every fresh launch walks the configured list from the beginning.

For each configured model:

1. attempt it
2. on a retryable model/provider startup failure, back off
3. attempt it again
4. back off
5. attempt it a third time
6. if it still cannot start, move to the next configured model

Three total attempts per configured model.

The backoff is small, bounded, and boring. Exact values can be finalized with tests, for example 500 ms then 1500 ms.

No historical state alters the order for the next launch.

### Retry boundary

Fallback/retry covers only failures that mean the configured model/provider could not successfully establish child execution.

Once a child has genuinely started executing the assigned task, its task outcome belongs to that run. Do not silently repeat real work on another model because tests failed, a tool failed, the implementation was wrong, or the child returned an unsuccessful task result.

Keep the classification boundary small:

- model/provider startup or availability failure: retry same model, then advance
- executed child outcome: terminal for that logical launch and reported normally

Do not grow another large recovery taxonomy while implementing this.

### Delete the exclusion cache

Remove the model exclusion subsystem wholesale.

Delete src/runs/shared/model-exclusions.ts and remove its callers.

Remove:

- persisted exclusions and TTL
- exclusion counts and status UI
- auth-store invalidation coupling
- stale exclusion detection
- transient-exclusion special cases
- exclusion clearing
- exclusion-related configuration and slash commands
- filterFallbackCandidates
- findModelExclusion
- recordModelFailure
- exclusion-driven branches in model fallback resolution
- exclusion unit/integration tests

A provider being unavailable may cost up to three attempts again on the next fresh launch. That cost is accepted in exchange for removing persistent adaptive state and a large maintenance surface.

Fleet should expose the current launch's attempt history instead.

## Agent definitions and management move to the TUI

All subagent definition and administrative work moves out of the model tool.

### TUI creation/edit flow

The Fleet/TUI should provide an Agents section with a creation flow for durable definition fields such as:

1. name
2. description/purpose
3. system prompt
4. tools
5. skills/extensions where retained
6. context behavior where retained
7. other durable definition fields that genuinely belong to the agent
8. save

Model selection and ordered fallbacks remain settings-owned rather than launch-owned.

The TUI may edit the durable underlying representation, but the model-facing subagent tool does not expose management actions.

### Remove model-facing management

Remove model access to actions such as:

- create/update/delete
- eject
- disable/enable/reset
- refine/refine.show/refine.rollback
- watchdog management
- mission management
- schedule management
- inspector/project management
- worktree cleanup/discard
- doctor/debug/admin operations
- model profile manipulation
- configuration mutation

Useful internal APIs can remain for the TUI, slash commands, or extension internals.

Removing a capability from the model schema does not require deleting the implementation when operators still need it.

### No agent override lattice

Remove the override architecture rather than reproducing it behind the TUI.

Do not preserve a precedence stack such as base definition -> user override -> project override -> provider override -> per-run override.

Prefer one authoritative durable agent definition plus settings-owned execution policy.

Model/fallback configuration should have a clear source and no per-launch override path.

## Budgets: soft guidance, high hard caps

Turn and tool budgets are operator/config owned.

The parent and child are informed of effective budgets but do not choose them.

Conceptually:

    {
      "subagents": {
        "defaults": {
          "turnBudget": { "soft": 16, "hard": 64 },
          "toolBudget": { "soft": 48, "hard": 192 }
        },
        "limits": {
          "maxDepth": 3,
          "maxChildrenPerRun": 64,
          "concurrency": 16
        }
      }
    }

Exact defaults are a separate tuning decision.

Semantics:

- soft budget: planning/finalization signal
- hard cap: high runtime safety limit against pathological loops

The child receives a concise startup notice with both soft and hard limits and guidance to prioritize completion as it approaches the soft target.

Crossing a soft threshold should produce at most one concise runtime reminder.

A child, workflow script, or parent tool call cannot raise the hard cap.

Fleet shows current / soft / hard values.

## What remains configuration-owned

Strong candidates to leave the public schema:

- model and fallbacks
- thinking/fast behavior if retained
- tool budget
- turn budget
- usage budget if retained
- timeout/max runtime
- tool timeout
- context mode/default inheritance
- worktree/isolation defaults
- concurrency and spawn limits
- nesting depth
- tool/skill/extension policy
- output/artifact defaults
- permissions
- machine placement if retained
- acceptance/output-schema behavior where retained as operator-level contract

The important distinction is intent versus policy.

cwd affects what work is requested and stays public. Model choice and timeout affect how the runtime executes it and move to config.

## Fleet becomes the operator cockpit

Fleet absorbs the complexity removed from the model schema.

For each run, show at least:

- run ID and lineage
- agent and task summary
- cwd
- worktree/branch when relevant
- current model and attempt history
- status and elapsed time
- latest activity
- turns: current / soft / hard
- tools: current / soft / hard
- tokens/usage where available
- completion delivery state
- pending attention/supervisor request
- transcript and artifacts
- worktree diff/status

Run controls include the useful human actions: steer, interrupt/stop where appropriate, resume/retry where appropriate, transcript, artifacts, open cwd/worktree, effective policy, and cleanup.

Agent management belongs in an Agents view with create/edit/delete flows.

The model does not need a shadow copy of these controls in its schema.

## Slash commands

Slash commands are an operator convenience layer over config and Fleet, not another competing management architecture.

Consolidate where practical under /subagents ...

Useful operator operations may include opening Fleet, opening agent creation/editing, viewing effective config, setting persistent config values, opening run details, and explicit operator controls.

Old aliases can survive briefly only for strong user-facing reasons. They should not dictate the internal architecture.

## Workflow simplification

Keep workflow scripts, but make them inherit the new boundary.

Keep:

- inline workflowScript
- runs.run
- runs.all
- resume by exact run ID
- steer/interrupt where useful
- per-child cwd

Remove from workflow child calls unless proven essential to orchestration:

- model and fallback models
- fast/thinking overrides
- async/foreground mode selection
- timeout/runtime overrides
- tool/turn/usage budgets
- concurrency/spawn-budget overrides
- worktree/isolation flags
- arbitrary tools/skills/extensions
- acceptance/gate overrides
- output schema overrides
- mission/schedule/watchdog controls
- machine placement overrides
- low-level persistence/session controls

Parallelism is expressed by runs.all. Sequential work is expressed by awaiting one run and launching the next.

The workflow describes topology. Config describes execution policy.

## Schema cleanup

The current compact schema is still a large schema with descriptions stripped. Replace it with an actually small schema.

After the overhaul there should be no need for full-versus-compact model-facing schema machinery.

Prefer a discriminated union internally and a concise tool description externally.

Done: the compact/full description modes are removed in src/extension/tool-description.ts in favor of one always-on default description plus an optional custom mode; custom templates interpolate it via the {{defaultDescription}} placeholder.

Validation should reject removed fields rather than silently ignoring them, so old call patterns do not survive invisibly.

## Breaking removals

The intended deletion set includes, subject to implementation discovery:

- subagents_enable and activation-selection machinery
- bg_wait and public wait schema/config/guidance
- model exclusion cache, persistence, TTL, config, and UI
- per-run model/fallback selection
- per-run budget and timeout tuning
- per-run runtime mode tuning
- agent management through subagent actions
- agentOverrides and provider-specific overrides
- model-facing schedules, missions, watchdogs, inspector/project actions, and worktree administration
- giant action enum/schema branches
- compact-vs-full schema mode
- obsolete docs/tests tied only to those surfaces

Do not preserve dead fields as undocumented compatibility parameters.

## Runtime behavior that remains

Preserve or adapt mature machinery that still serves the smaller contract:

- native async child execution
- completion notification and parent wakeup
- foreground/background internals where still required
- workflow runtime
- retained/resumable child sessions
- steer/resume/interrupt mechanics
- configured worktree allocation
- artifacts/transcripts
- Fleet observability
- internal control APIs needed by Fleet/TUI
- safety/permission enforcement
- run ownership and exact completion routing
The architectural move is to hide machinery behind a smaller interface, not to make the runtime primitive.

## Implementation sequence

### Phase 1: lock the new contract with tests

Add boundary tests before implementation changes.

Assert support only for launch, workflow, and steer/resume/interrupt control shapes. Assert that removed fields are rejected.

Add contract tests for launch receipts and automatic wake semantics.

### Phase 2: always-on tool

Remove subagents_enable and activation-state gating. Register subagent directly. Simplify tool/system guidance. Update tests and docs.

### Phase 3: automatic wake is the only synchronization path

Strengthen exactly-once delivery tests for normal completion, child failure, attention, nested completion, ownership, revival/session replacement where applicable, and duplicate suppression.

Then remove bg_wait, its schema, registration, config, docs, and tests. Remove all guidance suggesting polling.
### Phase 4: simplify model selection

Implement configured ordered candidate lists, three attempts per candidate, bounded backoff, advancement only on eligible startup/provider failure, and explicit exhaustion diagnostics.

Record attempt history on the run for Fleet and result diagnostics.

Then delete the exclusion subsystem and all exclusion-driven code paths.

### Phase 5: move execution tuning into resolved policy

Create one resolved run-policy object captured at launch.

It contains effective budgets, caps, timeout policy, context policy, isolation policy, tools/extensions/skills policy, model candidate list, and other retained execution settings.

Persist enough policy with the run to explain what actually happened.

Inject soft/hard budget information into child guidance.

### Phase 6: shrink public and workflow schemas

Delete the giant parameter surface. Reduce workflow child parameters to orchestration intent. Remove full/compact schema branching.
Keep internal runtime types separate from public tool input types so capability does not leak back into the schema.

### Phase 7: move management into Fleet/TUI

Build or consolidate the Agents view, create/edit/delete flows, model/fallback settings navigation/editing, run details, effective policy display, fallback attempt history, and steer/resume/interrupt controls.

Reuse internal management functions without keeping them model-visible.

### Phase 8: remove override architecture

Remove agentOverrides, provider-scoped overrides, and per-run override precedence.

Move legitimate durable definition fields into the authoritative agent definition or explicit settings fields.

Configuration provenance should be simple enough to explain in one short section.

### Phase 9: docs and dead-code sweep

Rewrite README quick start, tool reference, models, agents, workflows, configuration, and observability/Fleet docs.

Search for every removed field/action/tool name and delete obsolete guidance.

Run a final dead-code and unused-config sweep.
## Test strategy

Favor behavioral contract tests over preserving implementation-specific tests.

### Public boundary

- only intended fields validate
- old management/tuning fields fail validation
- subagent is always available
- control uses exact run IDs

### Async delivery

- launch returns immediately
- parent receives completion automatically
- no polling is required
- failure wakes parent
- attention wakes parent
- nested delegation routes to the correct owner
- duplicate completion is not delivered twice

### Model attempts

- candidate order is stable
- same candidate is attempted at most three times
- backoff occurs between retryable attempts
- fourth attempt on the same candidate never happens
- next candidate starts only after three eligible failures
- task-level child failure does not trigger another model
- fresh launch starts again at candidate one
- no state survives from the previous launch
- exhausted candidates produce actionable diagnostics

### Budgets

- effective soft/hard budgets resolve from config
- child sees both
- soft threshold produces one finalization reminder
- hard cap is enforced
- model/workflow cannot raise it

### TUI/Fleet

- create/edit agent flow produces the expected durable definition
- Fleet shows effective policy and model attempts
- operator steer/resume/interrupt target the correct run

## Acceptance criteria

The overhaul is done when a capable parent model can understand the delegation API in seconds.
A parent should only need to learn:

1. launch a named agent with a task
2. optionally choose cwd
3. use workflowScript when programmatic orchestration is useful
4. use steer/resume/interrupt for live control
5. never poll because completion wakes it automatically

The parent should not need to understand model fallback policy, health caches, exclusion TTLs, activation state, wait tools, budget tuning, worktree policy, agent administration, scheduling, watchdog administration, or persistence mechanics.

Operators should get the opposite experience: Fleet/settings should make effective policy and runtime state more visible than today.

A successful PR should substantially reduce public schema size, action count, configuration precedence complexity, model fallback statefulness, polling/wait machinery, documentation surface, and tests that exist only for removed compatibility behavior.

The desired architecture is powerful underneath and boring at the boundary.
