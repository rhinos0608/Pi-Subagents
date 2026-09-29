# Pi Subagents: Recipe Walkthroughs

Worked `workflowScript` examples for two planning handoffs ported from the
archived pre-overhaul skill. Both use the current surface: `runs.run` /
`runs.all` children with `key`, `agent`, `task`, plus `label` / `phase` for
readable status. There are no per-child model, budget, execution-mode,
context, or skill fields.

## Parallel context-build

Use before planning or implementation when a stronger handoff is needed. Run
two or three `context-builder` passes in parallel, each with a distinct
angle, then synthesize in the parent. Each builder reads the files its slice
needs, follows imports and callers, and returns a compact `meta-prompt`
section the parent can reuse for the planner or implementation owner.

```typescript
subagent({
  workflowScript: `
    const [scope, patterns, risks] = await runs.all([
      { key: "scope", label: "Build request scope context", agent: "context-builder", task: "Build request/scope context for: <goal>. Return scope, non-goals, and a compact meta-prompt." },
      { key: "patterns", label: "Build codebase pattern context", agent: "context-builder", task: "Build codebase/pattern context for: <goal>. Name source roots, files, and integration points, plus a compact meta-prompt." },
      { key: "risks", label: "Build validation risk context", agent: "context-builder", task: "Build validation/risk context for: <goal>. Name checks, edge cases, and open questions, plus a compact meta-prompt." }
    ]);
    return { scope: scope.output, patterns: patterns.output, risks: risks.output };
  `
})
```

The parent synthesizes important context, the recommended next meta-prompt,
open questions, assumptions, and artifact paths. Keep this recipe
read-only: builders gather context, they do not edit.

## Parallel handoff-plan

Use when the parent needs a solution brief plus an implementation-ready
meta-prompt from an external reference and local code context, such as
"study this library behavior, inspect our codebase, then produce an owner
brief." Fan out research and context gathering in parallel, then run one
synthesis step that consumes the earlier outputs.

```typescript
subagent({
  workflowScript: `
    const [ext, local, strategy] = await runs.all([
      { key: "ext", label: "Research external reference", agent: "researcher", task: "Research <external reference> and transferable implementation ideas for: <goal>. Return sources, confidence, and gaps." },
      { key: "local", label: "Build local codebase context", agent: "context-builder", task: "Build local codebase context for: <goal>. Name files, patterns, and constraints, plus a compact meta-prompt." },
      { key: "strategy", label: "Compare evidence and propose strategy", agent: "context-builder", task: "Compare external options against local constraints for: <goal> and propose an implementation strategy with tradeoffs." }
    ]);
    const synthesis = await runs.run("synth", {
      label: "Synthesize handoff plan",
      agent: "context-builder",
      task: "Write the final handoff plan and implementation-ready meta-prompt from: " + ext.output + " " + local.output + " " + strategy.output
    });
    return synthesis;
  `
})
```

Pass the aggregate result (or the synthesis output reference) to the single
implementation owner the parent launches next. If the tree is clean, give
concurrent owners isolated worktrees via `worktree: true` on each workflow child (or parent-created `cwd` values for single launches);
otherwise assign disjoint file ownership. Do not hand one child the whole
brief as a monolithic task: keep research, synthesis, and implementation as
separate stages with the parent owning scope decisions between them.
