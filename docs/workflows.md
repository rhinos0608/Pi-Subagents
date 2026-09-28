# Workflows and orchestration

How to compose subagents: the recommended pattern, packaged prompt shortcuts, scripted workflows, direct commands, and child-to-parent coordination.

## Recommended orchestration pattern

Use orchestration as parent-agent guidance, not as a runtime workflow mode. For implementation work, the recommended loop is:

```text
clarify → scout → worker → fresh reviewers → worker
```

Packaged `worker`, `oracle`, and `advisor` all launch with fresh context, so each child starts from its assigned brief instead of the parent's unfinished conversation.

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

For multi-step or parallel work, make exactly one top-level `subagent` workflow call and launch children only inside it. Available sandbox helpers include `runs.run`, `runs.all`, `runs.steer`, `runs.status`, `emit`, `console`, and standard JavaScript. No filesystem, shell, arbitrary Pi tools, or host globals are available.

Child results cross into the script as plain JSON data. Use returned fields such as `runId`, `ok`, `output`, and `structuredOutput` for workflow control.

Children always run awaited: the script continues once the child settles with its final result. `ok` confirms successful child completion, not successful dispatch.

A workflow can finish dispatch while these children remain running. Its summary and child rows identify that distinction. Consume the later child result before treating its work or report as complete.

Validate a script without launching children:

```js
subagent({ action: "validate", workflowScript: `
  const results = await runs.all([{ key: "scan", agent: "scout", task: "Scan" }]);
  return results[0].output;
` });
```

Each `runs.run` / `runs.all` child accepts exactly: `agent`, `task`, `cwd`, `resume`, `as`, `phase`, `label`, `lane`, `index`. There are no per-child model, thinking, tool-budget, timeout, context, skill, worktree, ref, output, outputMode, reads, progress, or async fields; those resolve from agent definitions and operator config.

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

### Retained children and follow-ups

Completed workflow children stay addressable as retained children with explicit `resumable` or `not resumable` state. A later workflow continues a resumable child by passing `resume` instead of `agent`, with explicit follow-up task text. `resume` and `agent` are mutually exclusive. Use a new stable workflow key for every distinct resume pass.

## Execution-mode boundaries

A failure in the subagent workflow, child launch, prompt runtime, extension loading, or child tooling setup is an infrastructure blocker. It is not permission to silently retry through another execution mode.

Stop and report the exact failure, run/status, and repository/cwd state. Retry or fix the `subagent` path only through a clear same-protocol action. External or foreground fallback requires explicit owner approval.

## Child-to-parent coordination

Children that need the parent mid-run use their supervised contact channel; the parent's completion and attention notices wake it without polling. The parent steers live children with `subagent({ action: "steer", ... })` and continues paused or finished children with `subagent({ action: "resume", ... })`.
