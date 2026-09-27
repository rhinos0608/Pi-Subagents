# Tool reference

Parameters and actions for the `subagent` tool. These are what the model passes when it calls the tool; most users ask naturally or use slash commands instead.

The `subagent` tool is registered and available whenever the extension loads. Direct execution remains the default; task complexity does not grant delegation authority.

A parent needs to learn only this: launch with `agent` + `task` (plus `cwd` when the work lives elsewhere, or `workflowScript` for composed work), then `steer` / `resume` / `interrupt` a live run, and never poll — completion and attention wake the parent.

## The model surface

Exactly 7 fields. Nothing else is accepted on a model call.

| Field | Type | Description |
|-------|------|-------------|
| `agent` | string | Agent to launch (direct child, or workflow child inside `runs.run` / `runs.all`). |
| `task` | string | The child's task. Requires `agent`. Excludes `action` and workflow inputs on a direct launch. |
| `cwd` | string | Override working directory. Defaults to runtime cwd. |
| `workflowScript` | string | Inline JavaScript statement body for composed work. See [workflows](workflows.md). |
| `action` | string | One of `steer`, `resume`, `interrupt`, `status`, `guide`, `validate`. Omit for launch. |
| `id` | string | Run id for `steer` / `resume` / `interrupt` / `status`. |
| `message` | string | Guidance text for `steer` / `resume`; focus detail for `status` transcript views. |

Actions:

- Launch: `subagent({ agent: "scout", task: "Map the auth flow" })` — no `action` field.
- `subagent({ action: "status", id: "<run-id>" })` — inspect one run; omit `id` for active runs.
- `subagent({ action: "steer", id: "<run-id>", message: "..." })` — acknowledged guidance to a live child.
- `subagent({ action: "resume", id: "<run-id>", message: "..." })` — continue a paused or completed child.
- `subagent({ action: "interrupt", id: "<run-id>" })` — pause a live child without stopping it.
- `subagent({ action: "guide", message: "workflows" })` — packaged guidance; reads do not change schema or grant authority.
- `subagent({ action: "validate", workflowScript: "..." })` — check script syntax and structure without launching. Returns `{ ok, errors }`; fails the tool call when `ok` is false.

Model, thinking, and context resolve from agent definitions plus operator config (see [models](models.md) and [agents](agents.md)). There are no per-call model / thinking / context parameters. Context is fresh by default, with operator/agent-level fork defaults where configured.

## Never poll

Completion and attention wake the parent. Do not loop on `status` to watch progress. Launch, do other work or yield, and react when the completion notice arrives. Fleet surfaces (`/subagents-fleet`, FleetView) exist for the operator to watch live work; they are not a reason for the model to poll.

## Execution examples

Chaining is code-driven through `workflowScript`. Use `await runs.run(...)` for sequential steps and `await runs.all([{ key, agent, task }, ...])` for ordinary parallel fanout. `runs.all` resolves to an ordered array, not a key map, so use indexes, destructuring, or `.map(...)`, not `results.<key>`. Do not read `.output` from an unawaited `runs.run` launch.

```js
// One child; return the child promise explicitly
{ workflowScript: `return runs.run("main", { agent: "scout", task: "Analyze the auth flow" })` }

// Sequential workflow
{ workflowScript: `
  const scan = await runs.run("scan", { agent: "scout", task: "Analyze auth" });
  return (await runs.run("implement", { agent: "worker", task: "Implement from: " + scan.output })).output;
` }

// Parallel workflow
{ workflowScript: `
  const results = await runs.all([
    { key: "backend", agent: "reviewer", task: "Review backend" },
    { key: "frontend", agent: "reviewer", task: "Review frontend" }
  ]);
  return results.map(result => result.output);
` }
```

### Workflow child fields

Each `runs.run` / `runs.all` child accepts exactly: `agent`, `task`, `cwd`, `resume`, `as`, `phase`, `label`, `lane`, `index`.

```js
{ workflowScript: `
  const scan = await runs.run("scan", { label: "Map codebase behavior", agent: "scout", task: "Scan the codebase" });
  const reviews = await runs.all([
    { key: "correctness", label: "Review codebase correctness", agent: "reviewer", task: "Review correctness: " + scan.output },
    { key: "tests", label: "Review test coverage", agent: "reviewer", task: "Review tests: " + scan.output }
  ]);
  return reviews.map(result => result.output);
` }
```

Child results cross into the script as plain JSON data. Use returned fields such as `runId`, `ok`, `output`, and `structuredOutput` for workflow control.

Children always run awaited: the script continues once the child settles with its final result. `ok` confirms successful child completion, not successful dispatch. Use `runId` to inspect a child.

### Output routing

Output routing is tooling-managed, not a per-child script field: `runs.run` / `runs.all` params do not accept `output` or `outputMode`.

Child outputs are saved to managed artifacts automatically. A filename mentioned in task text (for example, `Write your findings to exactly this path: report.md`) is only instruction and does not override runtime routing. When a later workflow step or parent needs a durable file, return the child's `outputReference` or `artifactPaths`.

Child results cross into the script as plain JSON data, including saved-output references.

### Retained children and resume

Completed workflow children from the current parent session stay addressable as retained children with explicit `resumable` or `not resumable` state. Resume only `resumable` rows: `subagent({ action: "resume", id: "<run-id>", message: "..." })`. Resume performs the authoritative eligibility check and may reject the attempt. When the exact run id of an intended direct child is known, inspect it with `{ action: "status", id: "<run-id>" }` first. If there is no known candidate or resume rejects eligibility, start a same-role fallback challenge and record why it is a fallback. Do not use `steer` as the challenge action for a completed child; `steer` targets live children.

A later workflow continues a resumable child by passing `resume` instead of `agent`:

```js
return runs.run("recheck", { resume: "<retained-run-id>", task: "Reconsider the implementation and make any better current-scope change." });
```

`resume` and `agent` are mutually exclusive; the revived child keeps its stored agent and tool contract. Use a new stable workflow key for every distinct resume pass.

### Workflow steering

`runs.steer(key, message, options?)` targets a stable key already launched by `runs.run` or `runs.all`. It does not accept a raw run id. Options are `mode?: "steer" | "follow_up" | "auto"` and `index?: number`. The promise returns `{ key, state, requestId?, deliveryStatus?, error? }`, where `state` is `queued`, `delivered`, `missed`, or `failed`. Always await, return, or include the promise in an awaited Promise combinator.

## Acceptance gates

Configure evidence gates on the agent definition or operator config; there is no per-call acceptance parameter. Levels: `checked` for ordinary writer evidence, `verified` when the runtime runs explicit validation commands. Reviewer and read-only calls omit acceptance. Disable with an explicit `none` level plus reason on the definition where lightweight lookup justifies it.

For one host-run verification command, an agent definition may carry `gate: "npm test"` shorthand. The object form `{ command, output?: "json", schema?, timeoutMs? }` adds a typed gate: with `output: "json"`, a passing command's stdout becomes the child's `structuredOutput`.

## Management lives outside the model tool

Agent management (list/create/update/delete/disable), run details, and run controls beyond `steer` / `resume` / `interrupt` / `status` live in Fleet (Agents view, run details) and slash commands — not in the model tool. The model tool has no list/get/create/update/delete, mission, schedule, watchdog, inspector, project, refine, lane-evidence, worktree, debug, doctor, stop, or dismiss actions.

## Accepted gaps

- Global default-model settings (`subagents.defaultModel`, `defaultProvider`, `defaultThinking` in settings files) have no Fleet writer. Hand-edit the settings file; see [models](models.md).
- Fleet resume is not a button. Resume via `subagent({ action: "resume", id, message })`, via `runs.run(newKey, { resume: runId, task })` inside a workflow, or via slash.
- Effective policy: at launch the runtime persists a compact resolved-policy snapshot into `status.json` (supervisor decision: persist-policy-snapshot). Fields: resolved model + thinking + origin, toolBudget soft/hard + source, timeoutMs + source, context, isolation/worktree, allowedTools union. Fleet run details render this snapshot via `formatResolvedPolicySnapshotLines` (`src/policy/snapshot.ts`).
