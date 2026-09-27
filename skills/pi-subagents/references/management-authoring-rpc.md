# Pi Subagents: Management Authoring Rpc

This file is a detailed reference loaded from `skills/pi-subagents/SKILL.md`.

Provenance: the flat `agentOverrides` operator layer is kept deliberately (supervisor decision) so an operator can disable, enable, and tune a role without forking shared or package-owned definitions. The provider-scoped override layer stays deleted.

## Management Mode

Agent management lives in Fleet (Agents view) and slash commands — not the model tool. The model tool has no list/get/create/update/delete, disable/enable, eject/reset, refine, mission, schedule, watchdog, inspector, project, lane, worktree, debug, doctor, stop, or dismiss actions.

### Fleet Agents view

Open `/subagents-fleet` and switch to the Agents view: list every discovered agent with source, enabled state, model, thinking, and fallback models. Keys: `c` create, `e` edit (model, thinking, prompt, description), `d` delete (user/project definitions only), `x` disable/enable, `Esc` close.

### Retained children

Completed workflow children stay addressable as retained children with explicit `resumable` / `not resumable` state. Resume only `resumable` rows:

```typescript
subagent({ action: "resume", id: "<run-id>", message: "..." })
```

Resume performs the authoritative eligibility check and may reject the attempt. Continue one inside a workflow with `runs.run(key, { resume: "<run-id>", task: "follow-up" })`; each workflow key identifies one result lane, so use a new stable workflow key for every distinct retained resume pass. The revived child keeps its stored agent, model, and tool contract. Start a same-role fallback challenge, labeled as fallback, only when no known candidate exists or resume rejects eligibility.

### Refinement overlays

Refinement overlays are bounded project-local guidance layered on one agent's system prompt without editing the agent file. Manage them through `/subagents-refine <agent>` and Fleet, not the model tool. Validated guidance is stored under `.pi/subagents/refinements/<agent>.md` with revision snapshots and is injected into that agent's child system prompt for this project. Guidance that tries to override safety, policy, tool, output, acceptance, developer, or system instructions is rejected.

### Creating and Editing Agents by File

A minimal agent file looks like this:

```markdown
---
name: my-agent
package: code-analysis
description: What this agent does
advertise: true
aliases: developer, coder
model: provider/model-id
thinking: high
tools: read, grep, find, ls, bash
systemPromptMode: replace
inheritProjectContext: true
inheritGlobalContext: false
inheritSkills: false
skills: safe-bash, review-checklist
skillPath: ./skills, ../shared-skills
---

Your system prompt here.
```

That is only a starting point. Omit `package` for the traditional unqualified runtime name. Set `advertise: true` only when the parent should receive this agent's name and description before deciding whether to delegate; advertisement is off by default. Common optional fields include:

- `defaultProgress`
- `defaultReads`
- `output`
- `aliases`
- `subagentOnlyExtensions`
- `skills`
- `skillPath`
- `memory`
- `maxSubagentDepth`
- `acceptance`
- `acceptanceRole`
- `async` — single-agent default for background launch (`true`/`false`)
- `timeoutMs` — single-agent default run-level max runtime in ms
- `machine` — saved Herdr machine placement for supported external-cli profiles
- `outputSchema` — JSON Schema object used as single-agent structured-output default

For small agent changes such as a model swap, prefer the settings override layer (pending the keep-vs-fold decision) or Fleet edit. Durable `.chain.md` definitions are legacy records, not a current authoring target; use `workflowScript` for repeatable orchestration.

## Prompt Template Integration

The package includes prompt shortcuts for common workflows: `/parallel-review`, `/review-loop`, `/parallel-research`, `/gather-context-and-clarify`, and `/parallel-cleanup`. Use them when the user wants repeatable review, review/fix loops, research, context handoff, implementation handoff, clarification, or cleanup-review patterns. `/parallel-review autofix` and `/parallel-cleanup autofix` synthesize reviewer feedback and then apply only the fixes worth doing now. Parent agents can also apply the same recipes directly with `subagent(...)` when the user describes the workflow in natural language instead of invoking a slash command.

Additional user prompt templates can delegate into `pi-subagents` through the native `/prompt-workflow` command. This is useful when a slash command should always run through a particular agent or with forked context. Prompt frontmatter can set `subagent`, `model`, `skill`, `cwd`, `fresh`, `fork`, or `inheritContext` for the native adapter.

## Extension RPC

Other Pi extensions can call `pi-subagents` through the in-process event bus. The RPC channels are `subagents:rpc:v1:ready`, `subagents:rpc:v1:request`, and per-request replies at `subagents:rpc:v1:reply:<requestId>`. Envelopes use `{ version: 1, requestId, method, params }`, and replies use `{ version: 1, requestId, success, data | error }`. `ping` advertises the exact process-local async completion event as `events.asyncComplete` for RPC-spawn consumers.

Methods: `ping`, `status`, `manage`, `spawn`, `steer`, `interrupt`, `resume`, `stop`, `result`, and `cost`. `result` preserves the fork's bounded terminal-result projection for a known run, while `cost` exposes upstream's versioned parent-plus-child accounting. `ping` capability metadata advertises fleet status, launch/runtime extension acknowledgements, cost accounting, and the supported management actions. Foreground `details.results[]` rows carry a stable numeric `index`; correlate children by `(runId, index)` rather than row position. Consumers should read status/result artifacts and RPC projections instead of scraping terminal output and must ignore unknown fields. `spawn` accepts either `{ agent, task? }` or an inline `workflowScript`; it is async-only and reuses the normal executor, so discovery, validation, session attribution, configured spawn caps, child-safety depth, artifacts, and async status remain shared with the `subagent` tool. `manage` accepts only the actions advertised by `ping.capabilities.managementActions`. `status`, acknowledged async `steer`, and `interrupt` map to the normal control actions. `resume` delegates to package-owned revival and cannot override persisted child authority. `stop` targets running async runs through the existing timeout control channel. `pi.events` is process-local, so separate Pi processes and child subagents need lifecycle artifact files or `pi-intercom` instead.
