# Pi Subagents: Execution Controls

This file is a detailed reference loaded from `skills/pi-subagents/SKILL.md`.

## Discovery and Scope Rules

Agent files can live in:

- `~/.pi/agent/agents/**/*.md` — user scope
- `.pi/agents/**/*.md` — canonical project scope
- legacy `.agents/**/*.md` — still read for compatibility, but `.pi/agents/` wins on conflicts

Precedence is by parsed runtime name:

1. project scope
2. user scope
3. builtin agents

Project settings resolve from the nearest parent directory containing `.pi` or `.agents` by default. In monorepos or git worktrees where an incidental nested `.pi` directory should not shadow the repository config, set `subagents.projectRootResolution: "git-root"` in the repository root `.pi/settings.json`; a nested project can opt back with `"nearest"` in its own settings.

## Running Subagents

The model tool has exactly 9 fields: `agent`, `task`, `cwd`, `workflowScript`, `args`, `action`, `id`, `message`, `topic` (`topic` is guide-only; `args` is a plain JSON object for `workflowScript` only, readable in the script as the frozen global `args` — never secrets). Launch omits `action`. Control actions are `steer`, `resume`, `interrupt`, `status`, plus `guide` and `validate`. Everything else (agent management, run stop, diagnostics, missions, schedules) lives in Fleet and slash commands.

### External CLI profiles

An agent may set `runner.type: external-cli` with a non-empty `command`, optional string `args`, and `promptDelivery: stdin` (the default). The command runs with `shell: false`, inherits the resolved cwd and environment, and receives the combined agent instructions and task through stdin. It must already be installed; pi-subagents adds no CLI dependency.

A command-runner agent with a plain `command` (no adapter) is also how a classifier or scoring script becomes a typed workflow step: the prompt arrives on stdin, stdout is the child's `output`, and the script parses it. External CLI profiles are async-only and one-shot. They support lifecycle artifacts, stdout/stderr logs, timeout, and stop. They do not support native Pi child options unless the runner explicitly implements them.

### External job profiles

An agent may set `runner.type: external-job` with a non-empty `provider` and optional JSON `options`. The provider must be registered in the host Pi process through `pi-subagents/external-job-provider`; the async runner talks to that parent-owned registry through a local operation bridge.

External job profiles are async-only. The provider owns the remote job and Pi owns the async run record. Recovery uses existing provider job metadata to call `reattach` and `result`; it refuses to redispatch a prompt when the persisted provider job does not match the prompt digest.

### Single agent

```typescript
subagent({
  agent: "oracle",
  task: "Review my current direction and challenge assumptions."
})
```

Use direct single-agent execution for one bounded task when no stable key, branching, retained-child lookup, or aggregate workflow result is needed. Use a `workflowScript` when the parent needs JavaScript control flow or data-dependent branching, or when the run is part of a larger coordinated wave.

Model, thinking, and context resolve from agent definitions plus operator config. There are no per-call model, thinking, tool-budget, timeout, context, or skill parameters.

### Launch context

Launches are always fresh: each child starts from its assigned brief, not the parent's unfinished conversation. Stale persisted `fork` context values are accepted for old data only and render no badge.

```typescript
subagent({
  workflowScript: `return runs.run("oracle-check", { agent: "oracle", task: "Review my current direction and challenge assumptions." })`
})
```

All packaged agents (`worker`, `oracle`, `advisor`) launch fresh.

Foreground results, async status, fleet, and widget surfaces label fresh children `[fresh]`. Stale persisted `fork` values render no badge. Aggregate headers show `[mixed]` when a run mixes modes.

### Scripted workflows

`workflowScript` is the public composition surface when the parent needs JavaScript control flow or data-dependent branching. Use `runs.run(key, { agent, task, ... })` for keyed children, `runs.all([...])` for parallel children, and ordinary JavaScript for sequence, filtering, retries, and aggregation. Scripts are ordinary JavaScript statement bodies, so use an explicit return such as `return runs.run("main", { agent: "worker", task: "..." })` for a useful one-child result. Use top-level `await`, plain helper functions, or explicit Promise chains; nested `async function` helpers, async arrows, and async methods are rejected.

Each `runs.run` / `runs.all` child accepts exactly: `agent`, `task`, `cwd`, `resume`, `as`, `phase`, `label`, `lane`, `index`, `worktree`. Pass `worktree: true` on a child for its own managed worktree (requires a clean git tree); omitted, the child uses the workflow/operator launch defaults (`prepareWorkflowLaunchParams` spreads `{...workflowDefaults, ...childParams}`, and `resolveWorkflowChildLocalCwd` falls back to the workflow cwd). Only `worktree: true` creates a per-child managed worktree via worktree admission. There are no per-child output, outputMode, reads, progress, model, thinking, tool-budget, timeout, context, skill, baseRef, isolation, ref, or async fields. Output routing comes from the agent definition (`output`, `outputMode`, `defaultReads`, `defaultProgress`) plus tooling-managed run artifacts: the runtime saves each child's managed output artifact and exposes it as the awaited `result.output` (with `outputReference` / `artifactPaths` for durable consumers). Name scratch report paths in task text and consume the aggregate workflow result; do not pass per-child output routing fields.

```js
subagent({
  workflowScript: `
    const scan = await runs.run("scan", { label: "Map target behavior", agent: "scout", task: "Map the target" });
    const reviews = await runs.all([
      { key: "correctness", label: "Review target correctness", agent: "reviewer", task: "Review correctness: " + scan.output },
      { key: "tests", label: "Review target test coverage", agent: "reviewer", task: "Review tests: " + scan.output }
    ]);
    return reviews.map(result => result.output);
  `
})
```

Scripts run in a timed worker with only `runs.run`, `runs.all`, `runs.status`, `emit`, captured `console`, and standard JavaScript. Pass explicit task text to `runs.run`. Stable keys are required. Give each child a distinct decision and output path when reports must outlive the workflow, then consume the aggregate workflow result before opening individual reports. Do not ask children to write `reports/...` or other repo-root scratch paths in task text.

For one host-run verification command, an agent definition may carry `gate: "npm test"` shorthand. For a typed post-run check, the object form `gate: { command, output: "json", schema?, timeoutMs? }` makes the parsed stdout the child's `structuredOutput`, so a script can branch on `result.structuredOutput` without the parent reading the child's output. For large summaries, set file-only output routing on the agent definition or override so the command reads the saved file. Typed gates are never memoized.

Completed workflow children from this parent session stay addressable as retained children with explicit `resumable` / `not resumable` state. Resume only `resumable` rows with `subagent({ action: "resume", id: "<run-id>", message: "..." })`. Resume performs the authoritative eligibility check and may reject the attempt. For a retained-child challenge, use `resume` instead of `steer` when the child is complete. Launch a same-role fallback challenge, labeled as fallback, only when no known candidate exists or resume rejects eligibility. A later workflow continues a resumable child with `runs.run(key, { resume: "<run-id>", task: "follow-up" })`. Pass explicit follow-up task text. `resume` and `agent` are mutually exclusive, and the revived child keeps its stored agent and tool contract.

Each workflow key identifies one result lane: use a new stable workflow key for every distinct retained resume pass; same-key calls are reused only when launch parameters are identical, and incompatible parameters are rejected.

### Parallel sequential lanes

For a broad plan with a known set of narrow, visible stages per lane, use `runs.lanes(...)` inside a `workflowScript`; it is a nested helper, not a top-level `subagent` mode. Give each lane and stage a stable key; give stage items a short verb + behavior `label`. The first stage from every lane is launched together, then later stages sequence per lane. A failed or blocked stage blocks only that lane. See the [canonical staged-lane example](../../../docs/workflows.md#parallel-sequential-lanes).

Use raw `runs.run(...)` / `runs.all(...)` instead when branching or rolling fanout depends on runtime data rather than a predeclared stage plan.

### Async/background

Placement follows agent defaults and operator config such as `asyncByDefault` and `forceTopLevelAsync`; there is no `async` call field on the model tool or on workflow children. Prefer background placement for every subagent launch. This applies to scouts, researchers, workers, reviewers, validators, oracle checks, one-off delegates, final review gates, publication gates, and scripted workflows.

Keep a launch in the foreground only when the parent must block until completion. Background placement still shows progress. Do not force foreground placement because a task is short, because it is the last gate, because no other work is ready, because the user asked to finish the overall job, or because blocking is convenient.

Async does not mean parallel writes. Do not edit the same active worktree while an async worker is changing it.

Do not end your turn immediately after launching an async child if you promised to keep working. Continue the local inspection, synthesis, or validation prep, then check the async run when its result is needed. If no safe independent work remains, return control and let Pi wake the session; do not convert the child to foreground.

In an ordinary interactive chat, normally return control after launching or triaging useful async work and let Pi wake the session on completion. Never poll `status` to wait. A run-to-completion user request is not by itself a reason to use foreground children.

```typescript
subagent({
  workflowScript: `return runs.run("main", { agent: "worker", task: "Run the full test suite" })`
})
```

Child outputs land in tooling-managed run artifacts. Name relative scratch report paths in task text so the runtime stores them under the run artifact directory and age-based cleanup can remove them. Use absolute paths only for user-approved durable destinations.

A filename mentioned in task text is only instruction; durable consumers should read the child's managed `outputReference` or `artifactPaths` from the awaited workflow result. When a later workflow step needs an earlier child's content, hold the awaited result in an ordinary JavaScript variable and interpolate it (or its managed artifact reference) into the later task text.

While children run, the persistent FleetView and the collapsed foreground tool-result card show live per-child detail. `/subagents-fleet` opens the live fleet inspector, which also has per-child controls (`s` steer, `D` stop with confirmation, `Enter`/`H` inspect).

Inspect async runs with `subagent({ action: "status", id: "..." })` or `subagent({ action: "status" })` for active runs. If a delegated fanout child launches nested runs, the parent status view shows them as a tree and you can target a nested run directly with its nested id.

Stop a current-session top-level async run from Fleet or slash (`/subagents-stop`). Stopped runs finish as `stopped`/cancelled and are not resumable. For an active foreground single-subagent run, `/subagents-detach [run-id]` leaves the child running without terminating it; the eventual result arrives via the completion notice and status.

Use `steer` for top-level live async guidance, `resume` after a delegated run pauses or finishes, and `interrupt` to pause a live child:

```typescript
subagent({ action: "steer", id: "run-id", message: "Focus on the failing test." })
subagent({ action: "resume", id: "run-id", message: "Follow up on this point." })
subagent({ action: "interrupt", id: "run-id" })
```

Resume behavior:

- `resume` revives paused, completed, or failed async/foreground children from persisted session files; stopped runs remain non-resumable, and it does not interrupt live top-level async children.
- Use `steer` for acknowledged guidance to a live top-level async child.
- If an async child has completed, `resume` revives it by starting a new async child from the persisted child session file.
- Multi-child async runs require `index` unless only one running child is selectable.
- Revive starts a new child session from the old session context; it does not resume the original child session.

Use diagnostics when setup or child startup looks wrong:

```text
/subagents-doctor
```

### Failed lane recovery and execution-mode changes

A failure in the subagent workflow, child launch, prompt runtime, extension loading, or child tooling setup is a lane infrastructure blocker, not permission to silently change execution mode. Stop and report the exact failure, run/status, and repo/cwd state. Retry or fix the `subagent` path only through a clear same-protocol retry; before retrying or asking the owner, verify the worktree is clean or capture the partial diff. For governed workflows, switching to `interactive_shell`, `pi -ne`, Codex/Claude/Cursor CLI, a foreground agent, or another external mode requires explicit owner approval. A verified compaction abort may continue the retained child session once on the same resolved model; provider failures never select another model automatically.

### External terminal work

Use native `subagent` runs for unattended implementation, review, and gate work that needs managed isolation, durable artifacts, and process controls. Use `interactive_shell` for visible terminal work, alternate CLIs, trust prompts, or recovery only when the user explicitly requests that mode or the task is outside the governed subagent protocol; it is not an implicit replacement for a failed `subagent` lane.

### Scheduled subagent runs

Timed and recurring runs are durable project records managed through slash commands and Fleet, not the model tool. Only schedule explicit work the user asked for. Runs launch async. Definitions, bounded history, append-only events, and per-run receipts remain project-scoped across Pi sessions.

Humans can use `/subagents-doctor` for the read-only setup report. It checks runtime paths, discovery counts, async support, current session context, and intercom bridge state.

### Subagent control

Subagent control is the runtime visibility and intervention layer for delegated runs. It is separate from lifecycle status. Lifecycle status says whether a child is `queued`, `running`, `paused`, `complete`, `stopped`, `failed`, or `rejected`. Activity reporting is factual: it tracks the last observed activity time and the current tool when known. It does not pretend to know that a child is truly stuck. Manual top-level async cancellation uses Fleet or `/subagents-stop`.

Default behavior is intentionally conservative. When no activity has been observed past the configured threshold, the run emits a `needs_attention` control event. Notification-worthy control events are also inserted into the visible transcript so both the user and the parent agent can see them, with a proactive hint plus concrete `nudge`, `status`, and `interrupt` options. Visible notifications fire once per child run and attention state.

Use soft interrupt when a child is clearly blocked or drifting and the parent needs to regain control:

```typescript
subagent({ action: "interrupt", id: "abc123" })
```

A soft interrupt cancels the current child turn and leaves the run paused. It does not mean the delegated task succeeded or failed. After an interrupt, decide the next explicit action: resume with clearer instructions, replace the task, ask the user, or stop the workflow via Fleet/slash.

Steering is acknowledged delivery, not a send attempt or model-compliance signal:

```typescript
subagent({ action: "steer", id: "abc123", message: "Focus on the failing test." })
```

Steering supports three delivery modes via the `mode` parameter (`steer` is the default):

- `mode: "steer"` — interrupt the child at the next safe point of its current turn and deliver the message.
- `mode: "follow_up"` — do not interrupt; queue input through Pi's native follow-up path for the next turn boundary.
- `mode: "auto"` — same next-safe-point delivery path as `steer`, but without automatic pause-and-revive recovery after a missed acknowledgment.

## Output and acceptance

Single-agent and workflow launches support `outputSchema` (JSON Schema object) for structured output; the runtime validates structured output and exposes it as `structuredOutput`. Acceptance is configured on agent definitions and operator config; there is no per-call acceptance parameter. Agent frontmatter may provide `acceptance`, `acceptanceRole`, and JSON `outputSchema` defaults.

Foreground children run in-process and do not load the parent's ambient extensions. MCP tools and provider-extension models therefore require background children, which load extensions in the detached runner.

## Watchdog

The subagent watchdog is an **opt-in** adversarial change reviewer. It is not the `reviewer` subagent and is not configured by default-model settings.

When enabled, it reviews actual repo edits at safe `agent_end` boundaries only if the final worktree state changed during that turn. Unchanged or reverted diffs and generated `.pi/subagents/` / temp artifacts do not trigger review. Use ordinary fresh-context `reviewer` fanout for planned review waves; enable watchdog when you want an automatic second pass on real edits. Watchdog itself is configured through settings and slash commands, not the model tool.

## Missions and cross-project routing

Missions are the durable orchestration layer. Use this noun map:

- **Project/codebase** — where work happens.
- **Mission** — why delegated work exists and how to recover it later.
- **Run** — one actual subagent execution.
- **Receipt** — proof or a link for an external outcome, such as a PR, CI check, deployment, or release.

Ordinary launches create a mission by default, so substantial delegated work has a persisted objective, status, run links, decisions, artifacts, and delivery receipts that survive compaction or a new parent chat. Pass `mission: false` on a workflow launch for intentionally ephemeral work. Mission management (record decisions, artifacts, receipts, close) runs through Fleet and slash commands, not the model tool.

Routing rule:

- Same project: ordinary mission-backed subagents.
- Different project, small/bounded task: ordinary async subagent with explicit `cwd`, an authority boundary, and durable output.
- Several projects with independent work: one async `workflowScript` whose child keys include repo slugs and whose child calls set explicit `cwd`; keep publication and merge decisions serial per repo.
- Different project, substantial or long-running work: open a project-owned session rooted there when a separate visible project session is useful, then give that project Pi session a narrow mission/result contract. Do not model it as ordinary child nesting.

## Worktree Isolation

When multiple agents might write concurrently, use managed worktree isolation instead of letting them share one filesystem view. In a workflow, pass `worktree: true` on each writer child; for single `{agent, task}` launches (no `worktree` field) the parent creates one git worktree per writer (outside auto-discovered extension dirs) and passes that path as the child's `cwd`. Fleet run details show the worktree/branch per child via the worktree summary. Git worktrees start from tracked files, so ignored or untracked build state such as `node_modules` may be absent — treat dependency setup as an explicit bootstrap step before running tests.

## The Oracle Workflow

### Oracle consultation loop

For plan, design, or architecture advice, start with one oracle run. Read its result. If it challenges the direction or leaves a material tradeoff, resume that same completed child once with a focused follow-up, then synthesize the parent decision. `resume` returns a new run id, but continues the same oracle session. Do not force a second round for an explicit one-shot request, a trivial question, or a fully settled first answer.

The parent remains the final decision-maker. Oracle advice does not approve a direction or start implementation.

```typescript
// Advisory review with a fresh brief. Oracle launches fresh like every child.
subagent({
  workflowScript: `return runs.run("oracle-check", { agent: "oracle", task: "Review my current direction, challenge assumptions, and propose the best next move." })`
})
```

## Subagent + Intercom Coordination

`pi-subagents` includes native supervisor coordination. Child agents can use `contact_supervisor` to ask the exact parent session that spawned them; messages are scoped by parent session id and should not appear in other Pi sessions. Parents inspect or reply with `subagent_supervisor`. This path does not require `pi-intercom`.

Use `contact_supervisor` with `reason: "need_decision"` when a subagent is blocked on a decision; `reason: "interview_request"` when the child needs structured supervisor input; `reason: "progress_update"` for concise non-blocking progress. Routine completion handoffs are not expected.

If bridge instructions provide the child-facing tool, a child can ask:

```typescript
contact_supervisor({
  reason: "need_decision",
  message: "Should I optimize for readability or performance here?"
})
```

The parent replies with the native supervisor tool:

```typescript
subagent_supervisor({ action: "reply", message: "Optimize for readability." })
```

If intercom messages do not show up, run `/subagents-doctor`.
