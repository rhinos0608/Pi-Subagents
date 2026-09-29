# Workflows and orchestration

How to compose subagents: the recommended pattern, packaged prompt shortcuts, scripted workflows, direct commands, and child-to-parent coordination.

## Recommended orchestration pattern

Use orchestration as parent-agent guidance, not as a runtime workflow mode. For implementation work, the recommended loop is:

```text
clarify → scout → worker → fresh reviewers → worker
```

Packaged `worker`, `oracle`, and `advisor` all launch with fresh context, so each child starts from its assigned brief instead of the parent's unfinished conversation. Do not hand one subagent a monolithic task; either stage it sequentially (for example scout → worker → reviewer) or fan out across independent seams or files.

Failed workflow details and async `status.json` include `workflow.failureKind` as `validation`, `script`, `child`, `return-serialization`, `timeout`, `detached-child`, or `runtime`. `validation` means the host rejected the script before it ran (syntax or portability) or at completion (unawaited calls); errors thrown into a running script, including rejected `runs.run` parameters and runtime `SyntaxError`s, are `script` because the script could catch them, and failed children are `child`. `runtime` covers host setup and infrastructure failures, such as an unavailable cwd or a crashed worker. A workflow that is stopped or reloaded is not a failure and has no `failureKind`.

When `/reload`, a session resume, or a pi-web project switch replaces the extension runtime, a running async workflow stops with `workflow.stopCause: "runtime-replaced"` in `status.json`, and its awaited async children keep running. When the same `workflowScript` is launched again with the same `args` in that session, a `runs.run` with the same key and params returns a child that already finished successfully without launching it, and waits for a child that is still running instead of starting another. Those results carry `reused: true`, their step and trace entry are marked `reused`, and the new run records `workflow.reusedFrom`. Failed and stopped children, and children that ran in-process, launch again. Reuse applies only when the newest run of that script and args in the session was stopped this way; a user stop or a completed run ends it. A settled `worktree: true` child is reused only while every file its result references still exists; if its worktree or artifacts were cleaned up after the stop, the child runs again.
## Prompt shortcuts

The package includes reusable prompt templates for common workflows. You do not need them, but they are handy when you want the same shape every time:

| Prompt | Use it for |
|--------|------------|
| `/parallel-review` | Launch fresh-context reviewers with distinct angles, then synthesize what to fix. |
| `/review-loop` | Run parent-controlled worker, reviewer, and fix-worker cycles until clean or capped. |
| `/parallel-research` | Combine `researcher` and `scout` for external evidence, local code context, and practical tradeoffs. |
| `/gather-context-and-clarify` | Scout/research first, then ask the user the clarification questions that matter. |
| `/parallel-cleanup` | Run review-only cleanup passes after implementation. |

Add `autofix` to `/parallel-review` or `/parallel-cleanup` to apply only the synthesized fixes worth doing now after reviewers return.

## Scripted workflows (workflowScript)

Use direct `{ agent, task }` for one bounded child. Use `workflowScript` when the parent needs a stable keyed child, sequence, fanout, steering, retry, or aggregation. For ordinary parallel fanout, use `await runs.all([{ key, agent, task }, ...])`. It resolves to an ordered array, not a key map, so use indexes, destructuring, or `.map(...)`, not `results.<key>`. Do not read `.output` from unawaited `runs.run` launches. Scripts are ordinary JavaScript statement bodies. Use an explicit `return` for a useful result:

For multi-step or parallel work, group it inside one top-level `subagent` workflow call and launch children inside it; this reduces turns compared to multiple sequential tool calls. Available sandbox helpers include `runs.run`, `runs.all`, `runs.steer`, `runs.status`, `emit`, `console`, and standard JavaScript. No filesystem, shell, arbitrary Pi tools, or host globals are available.

Child results cross into the script as plain JSON data. Use returned fields such as `runId`, `ok`, `output`, and `structuredOutput` for workflow control.

Children always run awaited: the script continues once the child settles with its final result. `ok` confirms successful child completion, not successful dispatch.

A workflow can finish dispatch while these children remain running. Its summary and child rows identify that distinction. Consume the later child result before treating its work or report as complete.

### Workflow args (`args`)

A top-level `subagent({ workflowScript, args })` call can pass data into the script as the frozen global `args` — no string interpolation needed. `args` must be a plain JSON object (total ≤ 16 KB; string values non-empty, ≤ 16 KB each; depth ≤ 8; arrays ≤ 64 items; objects ≤ 16 keys with non-empty names; numbers finite), is deep-frozen before the script reads it, and is persisted as run evidence, so never put secrets in it. `args` without `workflowScript` is rejected.

```js
subagent({ workflowScript: `
  return "Reviewing " + args.repo + " at severity " + args.severity;
`, args: { repo: "auth", severity: "high" } });
```

Validate a script without launching children:

```js
subagent({ action: "validate", workflowScript: `
  const results = await runs.all([{ key: "scan", agent: "scout", task: "Scan" }]);
  return results[0].output;
` });
```

Each `runs.run` / `runs.all` child accepts exactly: `agent`, `task`, `cwd`, `resume`, `as`, `phase`, `label`, `lane`, `index`, `worktree`. There are no per-child model, thinking, tool-budget, timeout, context, skill, ref, output, outputMode, reads, progress, or async fields; those resolve from agent definitions and operator config.

`worktree: true` gives that child its own managed worktree at a mirrored subpath (requires a clean git working tree — commit or stash first); omit it to use the workflow/operator default. `worktree` must be a boolean; `baseRef` / `isolation` / provider overrides stay rejected on children.

The result is `{ ok, errors }`. Invalid scripts return a tool error and include line and column data when available. Validation checks syntax, portable nested-async rules, literal `runs.run` and `runs.all` keys, duplicate literal keys in one `runs.all` group, direct keyed access to a known `runs.all` result, and statically clear non-JSON boundary values. It also looks up literal `agent` names in `runs.run`, `runs.all`, and `runs.lanes` children against the agents discovered for the request `cwd`, and reports unknown or ambiguous names with a close match when one exists. Children with their own `cwd` or `resume`, object spreads, and names built at runtime are left to launch time. Dynamic keys and other runtime-only values are accepted without a warning. Validation does not launch children or create run artifacts. Executing a workflow runs the same agent-name check first, so an unknown literal agent fails before any child launches.

```js
subagent({ workflowScript: `
  const scan = await runs.run("scan", { label: "Map codebase behavior", agent: "scout", task: "Scan the codebase" });
  const reviews = await runs.all([
    { key: "correctness", label: "Review codebase correctness", agent: "reviewer", task: "Review correctness: " + scan.output },
    { key: "tests", label: "Review test coverage", agent: "reviewer", task: "Review tests: " + scan.output }
  ]);
  return reviews.map(result => result.output);
` });
```

### Parallel sequential lanes

Use `runs.lanes(lanes)` inside a `workflowScript` when several independent lanes each have ordered stages. This helper composes the existing workflow child runner; it does not add a top-level `lanes` parameter or a second persistence system.

```js
{ workflowScript: `
  const board = await runs.lanes([
    { key: "api", stages: [
      { key: "writer", agent: "worker", task: "Implement the API change" },
      { key: "review", agent: "reviewer", task: "Review the API lane" }
    ] },
    { key: "ui", stages: [
      { key: "writer", agent: "worker", task: "Implement the UI change" },
      { key: "review", agent: "reviewer", task: "Review the UI lane" }
    ] }
  ]);
  return board.map((lane) => ({ key: lane.key, state: lane.state }));
` }
```

The first stage of each lane is launched by one existing `runs.all(...)` batch. Later stages run in lane order. A failed or stopped stage blocks only its lane and marks later stages `skipped`. Use raw `runs.run(...)` / `runs.all(...)` for conditional or rolling workflows.

### Workflow steering

`runs.steer(key, message, options?)` targets a stable key already launched by `runs.run` or `runs.all`. It does not accept a raw run id. Options are `mode?: "steer" | "follow_up" | "auto"` and `index?: number`. Always await, return, or include the promise in an awaited Promise combinator.

For advanced rolling fanout, keep launched `runs.run` promises only when every promise is later observed with direct `await`, `Promise.race`, or `Promise.all`. `Promise.race` gives the next completed child, `runs.steer` can challenge a still-running keyed sibling, and `Promise.all` collects the rest.

### Output routing

Output routing is tooling-managed, not a per-child script field: `runs.run` / `runs.all` params do not accept `output` or `outputMode`. Child outputs are saved to managed artifacts automatically. A filename mentioned in task text is only instruction and does not override runtime routing. When a later workflow step or parent needs a durable file, return the child's `outputReference` or `artifactPaths`.

The workflow result text keeps the Return, Emitted, and Console sections, and a failed workflow's error, under 200 KB and 5000 lines. Each call-trace error is shortened to 500 characters. When anything is cut, a `[TRUNCATED: ... - full output at <path>]` line points to the uncut text, which is written to `<run>_workflow-result.md` under the run's artifacts directory. That file sits outside the `outputs/` tree where children save their reports and has the same retention as the other run artifacts in that directory: age-based cleanup removes it from temp and session artifact directories, while `artifactDir: "project"` files are kept. The status line, the rest of each trace line, warnings, and output-path mappings are never cut.

### Retained children and follow-ups

Completed workflow children stay addressable as retained children with explicit `resumable` or `not resumable` state. A later workflow continues a resumable child by passing `resume` instead of `agent`, with explicit follow-up task text. `resume` and `agent` are mutually exclusive. Use a new stable workflow key for every distinct resume pass.

## Execution-mode boundaries

A failure in the subagent workflow, child launch, prompt runtime, extension loading, or child tooling setup is an infrastructure blocker. It is not permission to silently retry through another execution mode.

Stop and report the exact failure, run/status, and repository/cwd state. Retry or fix the `subagent` path only through a clear same-protocol action. External or foreground fallback requires explicit owner approval.

## Child-to-parent coordination

Children that need the parent mid-run use their supervised contact channel; the parent's completion and attention notices wake it without polling. The parent steers live children with `subagent({ action: "steer", ... })` and continues paused or finished children with `subagent({ action: "resume", ... })`.
