# Upstream sync decision log — 2026-10-15

> **Status: selective integration, not a full upstream merge.** This ledger distinguishes applied commits from those still needing review or adaptation. No untested all-tree merge was retained.

## Sources and scope

- Fork integration branch: `merge/upstream-v0.78.0-20261015`, based on the September integration `merge/upstream-v0.73.1-20260929` (`feabd0df`).
- Upstream: `nicobailon/pi-subagents` `upstream/main` at `2ac33ce1` (latest published tag `v0.78.0`).
- This pass inventories **194 non-merge commits** after `4416738f`, the prior upstream sync endpoint. The older 46-commit triage remains in `docs/fork-delta.md`.
- Do **not** fast-forward or reset the dirty original `/Users/rhinesharar/pi-subagents` checkout; it contains separate uncommitted work. The integration is isolated in `/Users/rhinesharar/pi-subagents-upstream-v078-sync`.

## Binding fork decisions

- **FD-001/002**: exactly 9 model-facing top-level keys and 6 actions, with internal management through Fleet, slash commands, and RPC.
- **FD-003/010**: strict 11-field workflow child allowlist, including owner-approved `outputSchema`; no per-call model/thinking/budget/timeout controls.
- **FD-006/007**: fresh child contexts, operator-owned execution policy, always-on tool; no `subagents_enable`, `bg_wait`, or fork-parent context.
- **FD-008/009/011**: keep the safety kernel, result/runtime RPC extensions, and scoped `@rhinos0608/pi-subagents` package identity; reject upstream private/release version changes.
- Keep upstream runtime fixes only when they do not silently resurrect deleted surface or duplicate existing mechanisms. Changes to protected seams need explicit adaptation and regression tests.

## Integration method and evidence

- Tried Git full-tree merge from the September sync baseline with both conflict biases. TypeScript reported **134** (`ours`) and **183** (`theirs`) incompatible references; both trials were aborted without committing. These are unsafe integration paths, not completed merges.
- Selected standalone upstream commits for chronological `cherry-pick -x`. Each accepted commit passed `npm run typecheck`; conflicts in fork-sensitive files were aborted. One accepted patch candidate failed TypeScript and was rolled back.
- Separate dependency backport: `f7732d6b` (`undici` 8.10.0 → 8.10.2, advisory GHSA-3wwx-pv8p-q78v), on the fork manifest with an explicit upstream trailer.
- Fork boundary test gate: **109 passed, 0 failed**, covering 9-key tool, hidden internal actions, dormant removed fields, and workflow child structured output.

## Priority adaptations not completed

- **Project trust isolation** (`b2718fb8`, `30a13205`, `005a380e`): propagate host trust into children and suppress project settings/discovery for untrusted sessions without reviving fork-context features.
- **Runner state and output durability**: source-level conflict auditing for result cleanup/leases, shutdown, notices, and session lifecycle must precede adoption.
- **Public workflow API**: upstream reply-fenced workflows, named workflows, `workflow: true`, and top-level management options conflict with the explicitly retained `workflowScript` and small schema; do not auto-merge.
- **A TypeScript-blocked patch**: `63ac9c2a` requires adapting the fork `AtomicJsonFs` interface, rather than replacing it with upstream assumptions.

## Commit-by-commit dispositions

**TAKE** = present and independently typechecked. **ADAPT** = attempted but conflicted/failed compile, or explicitly impacts a fork boundary. **SKIP** = excluded by a recorded fork invariant. **DEFER** = not applied or fully reviewed in this pass; not a rejection.

| Upstream | Disposition | Commit | Decision / blocker |
|---|---|---|---|
| `f7732d6b` | TAKE | fix(deps): bump undici to 8.10.2 for GHSA-3wwx-pv8p-q78v (#2548) | security backport; fork package identity preserved |
| `f34efb13` | TAKE | test(agents): mark package fixture root (#2553) | cherry-picked and typechecked |
| `08192e4b` | TAKE | perf(watchdog): capture the diff baseline without blocking session start (#2563) | cherry-picked and typechecked |
| `a4e5a76a` | TAKE | perf(retention): probe Windows process start time without blocking (#2564) | cherry-picked and typechecked |
| `12e930a7` | DEFER | herdr: avoid counting workflow coordinators (#2556) | not ported in this checkpoint |
| `4ad89060` | TAKE | perf(supervisor): stop idle Windows channel polling (#2565) | cherry-picked and typechecked |
| `30f73a37` | DEFER | fix(workflows): report siblings stopped by a failed workflow as stopped (#2566) | not ported in this checkpoint |
| `0a24a215` | DEFER | fix(workflows): report foreground siblings stopped by a failed workflow as stopped (#2568) | not ported in this checkpoint |
| `b2718fb8` | ADAPT | fix(children): follow the parent session's project trust (#2570) | project trust must be threaded through fork-owned child launch path |
| `2bddf29b` | DEFER | fix(workflows): stop async workflows and their children on user stop (#2572) | not ported in this checkpoint |
| `14dcf975` | DEFER | feat(mcp): support Pi built-in MCP for mcp: tool selections (#2573) | not ported in this checkpoint |
| `fa1de042` | DEFER | fix(mcp): keep pi-mcp-adapter priority when it registers /mcp-adapter (#2576) | not ported in this checkpoint |
| `8f90bf1b` | DEFER | fix: register Pi codemode in native child sessions (#2574) | not ported in this checkpoint |
| `082c4378` | DEFER | fix(schema): anchor the acceptance JSON-string pattern for llama.cpp (#2582) | not ported in this checkpoint |
| `9a5a2d5e` | TAKE | fix(tui): show lanes instead of blank rows in the progressive async widget (#2583) | cherry-picked and typechecked |
| `7e07a22d` | TAKE | fix(tui): count running agents the same way in the async widget and Fleet view (#2584) | cherry-picked and typechecked |
| `964481f4` | DEFER | fix(workflows): show a revived workflow child as its key's latest run (#2585) | not ported in this checkpoint |
| `09585988` | DEFER | fix: keep delegation and supervisor tools out of codemode scripts (#2586) | not ported in this checkpoint |
| `0538e14d` | DEFER | feat(workflows)!: launch workflow scripts from a fenced block in the reply (#2588) | not ported in this checkpoint |
| `624d69c4` | DEFER | fix: load the subagent executor once per process so on-disk updates cannot mix versions (#2594) | not ported in this checkpoint |
| `92a8a1f5` | SKIP | feat: pick subagent tool activation from the model to avoid cache misses (#2595) | model-chosen activation conflicts with permanently registered tool |
| `71d042f0` | SKIP | feat(workflows): run chain and tasks when workflow scripts are disabled (#2596) | legacy chain/tasks model API remains intentionally removed |
| `ca534364` | DEFER | refactor: deslop unreleased changes (#2597) | not ported in this checkpoint |
| `b6bda32f` | SKIP | chore(release): v0.74.0 | upstream version/publish identity is not fork identity |
| `2bc2a029` | DEFER | fix: deliver goal notices after auto-drain failures (#2605) | not ported in this checkpoint |
| `36081c57` | TAKE | fix: isolate goal continuation notice errors per mission (#2604) | cherry-picked and typechecked |
| `806e3678` | TAKE | fix: reconcile Linux zombie runners in the same PID namespace (#2606) | cherry-picked and typechecked |
| `3f367e75` | DEFER | fix: match Pi's built-in MCP names for hyphenated mcp: selectors (#2607) (#2609) | not ported in this checkpoint |
| `cfb6f9a8` | ADAPT | fix: validate workflow args and state their limits up front (#2611) | workflow args validation must preserve frozen JSON contract |
| `478f871c` | DEFER | fix: notify attention for each long-open tool call (#2613) | not ported in this checkpoint |
| `df3b6df1` | DEFER | fix: treat workflow "true" from MCP clients as workflow: true (#2610) | not ported in this checkpoint |
| `ae9c9d77` | DEFER | fix: count every resumed foreground workflow round in /subagent-cost (#2612) | not ported in this checkpoint |
| `4998ceca` | ADAPT | fix: stop /subagent-cost logging missing workflow receipts and mark them unavailable (#2615) | test/unit/subagent-cost.test.ts |
| `d6726aea` | TAKE | fix(missions): project global list summaries from authoritative records (#2618) | cherry-picked and typechecked |
| `8a577c27` | ADAPT | fix(profiles): validate machine overrides before applying settings (#2619) | docs/models.md,src/profiles/profiles.ts |
| `9240e7e2` | DEFER | feat: attach scheduled workflows to existing missions (#2616) | not ported in this checkpoint |
| `53aee6d8` | DEFER | feat(tui): allow collapsed async widget (#2621) | not ported in this checkpoint |
| `9f1c2552` | DEFER | fix: fail closed instead of dropping authority and permission config (#2624) | not ported in this checkpoint |
| `04113d7b` | DEFER | test: give the early-completion checkpoint child a 12s budget (#2626) | not ported in this checkpoint |
| `aba33819` | TAKE | fix: preserve bounded Codex composite tool IDs (#2628) | cherry-picked and typechecked |
| `ac13ab87` | DEFER | fix(dynamic-fanout): run external-runner agents in background expand steps (#2630) | not ported in this checkpoint |
| `aafcfb31` | DEFER | feat: let the Claude Code adapters take a model and a thinking level (#2603) | not ported in this checkpoint |
| `0ad173c9` | ADAPT | test: retry goal fixture cleanup in the agent_end auto-drain test (#2633) | test/unit/agent-end-auto-drain.test.ts |
| `10694a67` | DEFER | Let background subagents start on Pi 1.0.0, which no longer ships the agent-core node module (#2634) | not ported in this checkpoint |
| `07946874` | TAKE | fix: flush queued virtual model registrations in child sessions (#2636) | cherry-picked and typechecked |
| `1fe508f1` | ADAPT | fix: verify virtual-model children against their selection, not the dispatched model (#2638) | docs/configuration.md |
| `dbb92db1` | ADAPT | fix: reject a child whose required extension fails during startup (#2640) | src/runs/shared/child-session.ts |
| `552f1dd7` | DEFER | feat: let hosts require child extensions for every runner (#2643) | not ported in this checkpoint |
| `f517481f` | DEFER | fix: record async runs in run-history.jsonl (parity with foreground executor) (#2620) | not ported in this checkpoint |
| `63ac9c2a` | ADAPT | fix(settings): save builtin agent overrides atomically (#2627) | src/agents/agents.ts(963,3): error TS2739: Type '{ mkdirSync: { (path: PathLike, options: MakeDirectoryOptions & { recursive: true; }): string / undefined; (path: PathLik |
| `69a830c0` | ADAPT | fix: launch npm-installed external CLIs on Windows without a shell (#2647) | test/integration/claude-code-dispatch.test.ts,test/unit/claude-code-dispatch.test.ts |
| `9eb55dd9` | DEFER | Test clean installs against Pi 1.0.0 (#2648) | not ported in this checkpoint |
| `72682254` | DEFER | feat: opt-in command supervision for native Pi children (#2598) | not ported in this checkpoint |
| `6fa9f9fe` | DEFER | chore: tighten unreleased code, tests, and changelog (#2649) | not ported in this checkpoint |
| `ad56bf92` | SKIP | chore(release): v0.75.0 | upstream version/publish identity is not fork identity |
| `8d804895` | TAKE | fix: shrink the progressive async widget when jobs leave (#2662) | cherry-picked and typechecked |
| `7cb20ce9` | DEFER | fix: run a lone plain js block for workflow: true and explain the opener (#2660) | not ported in this checkpoint |
| `8fb89814` | TAKE | fix: release abandoned workflow capacity slots (#2663) | cherry-picked and typechecked |
| `9bc8f2d1` | DEFER | fix: return unfinished streamed text as partial output on timeout or child error (#2653) | not ported in this checkpoint |
| `1a255e91` | DEFER | docs: note the abandoned-slot exception in the capacity proof rules (#2664) | not ported in this checkpoint |
| `3ae772c9` | DEFER | feat: apply reviewed worktree cleanup plans (#2655) | not ported in this checkpoint |
| `9a40e7fb` | DEFER | test: keep the slow workflow sibling running until the stop aborts it (#2665) | not ported in this checkpoint |
| `ff2e00bd` | TAKE | fix(watchdog): record mid-run user messages in scope and state changed-path provenance (#2661) | cherry-picked and typechecked |
| `a4b1fb9d` | DEFER | feat: support daily and weekly zoned schedules (#2656) | not ported in this checkpoint |
| `3bb9b203` | DEFER | fix: deliver finished async results before a headless turn settles (#2666) | not ported in this checkpoint |
| `620cefa3` | DEFER | fix: explain when the reply's text never reached the session for workflow: true (#2670) | not ported in this checkpoint |
| `33f427fc` | DEFER | fix: grant built-in MCP tools for the -/_ form of a server name (#2671) | not ported in this checkpoint |
| `8983754b` | DEFER | fix: save the structured result to a bound output file (#2672) (#2673) | not ported in this checkpoint |
| `d67d3173` | DEFER | fix: preserve schedule owner state after lock contention (#2675) | not ported in this checkpoint |
| `cccba0cf` | TAKE | fix: release a schedule claim whose lock file could not be written (#2679) | cherry-picked and typechecked |
| `2d3f6471` | ADAPT | fix: serialize extension settings updates across sessions (#2680) | src/agents/agents.ts,src/runs/shared/worktree-lock.ts |
| `49a3ec7f` | TAKE | fix: preserve multiline agent descriptions when saving (#2681) | cherry-picked and typechecked |
| `650244c3` | ADAPT | fix: serialize schedule history updates across sessions (#2682) | src/runs/background/scheduled-runs.ts |
| `50412418` | DEFER | fix: keep sessions live until child results reach the parent (#2683) | not ported in this checkpoint |
| `1edc2b20` | TAKE | fix: compare schedule claim lock file ids exactly on Windows (#2684) | cherry-picked and typechecked |
| `5855164a` | TAKE | fix: compare Windows samePath file ids exactly (#2686) | cherry-picked and typechecked |
| `99ccd391` | SKIP | chore(release): v0.76.0 | upstream version/publish identity is not fork identity |
| `7fd88df8` | DEFER | fix: preserve queued completion ownership across reload (#2687) | not ported in this checkpoint |
| `65dff229` | DEFER | fix: wake an idle parent through the prompt lifecycle (#2689) | not ported in this checkpoint |
| `700c91bc` | DEFER | chore: add the extension npm keyword (#2690) | not ported in this checkpoint |
| `17e17673` | TAKE | fix: put child boundary instructions after Pi's base prompt (#2693) | cherry-picked and typechecked |
| `ba008223` | TAKE | fix: report the tool timeout that ended a child, not the run deadline (#2694) | cherry-picked and typechecked |
| `6826b054` | DEFER | fix: tell the user to restart Pi when an update leaves old modules loaded (#2697) | not ported in this checkpoint |
| `f738f855` | DEFER | fix: make doctor count the same async capacity pool as launch admission (#2700) | not ported in this checkpoint |
| `15757b00` | DEFER | fix: stop a paused run after its result was delivered (#2701) | not ported in this checkpoint |
| `1faa0c08` | DEFER | fix: stop marking the Herdr pane blocked when a child needs its parent (#2703) | not ported in this checkpoint |
| `7d072b91` | SKIP | chore(release): v0.76.1 | upstream version/publish identity is not fork identity |
| `1ec410b3` | TAKE | perf: format only the latest streamed tool calls in foreground progress (#2708) | cherry-picked and typechecked |
| `e44fe0df` | TAKE | perf: keep Fleet's rendered transcript across periodic refreshes (#2709) | cherry-picked and typechecked |
| `3c729c4f` | TAKE | fix: release Herdr bridge frames after the session adopts the transport (#2710) | cherry-picked and typechecked |
| `5da80816` | DEFER | fix: give output-less workflow resumes their own report path (#2712) | not ported in this checkpoint |
| `50c280f1` | DEFER | fix: drop the deprecated keyword from the acceptance tool schema (#2721) | not ported in this checkpoint |
| `e4b52b4b` | DEFER | feat: wrap background runners in user-defined launchers (#2720) | not ported in this checkpoint |
| `3be46a22` | DEFER | fix: carry child usage onto workflow step rows (#2723) | not ported in this checkpoint |
| `58c7f613` | DEFER | fix(rpc): align queued and paused stop handling with tool policy (#2722) | not ported in this checkpoint |
| `3d4764de` | DEFER | fix: bound parent continuations for unanswered subagent wakes (#2716) | not ported in this checkpoint |
| `ac848775` | DEFER | feat: report subagent run state to the terminal with OSC 7501 (#2725) | not ported in this checkpoint |
| `cceb676c` | DEFER | feat(inspector): bundle a tmux inspector plugin (#2719) | not ported in this checkpoint |
| `5096985c` | DEFER | fix: serialize inspector open and close per run (#2728) | not ported in this checkpoint |
| `655986a0` | DEFER | test: retry command-action cleanup on Windows file locks (#2729) | not ported in this checkpoint |
| `6a6675c9` | DEFER | fix(rpc): preserve run correlation and align stop handling (#2717) | not ported in this checkpoint |
| `48f7e28c` | ADAPT | fix: explain foreground failures on inherited extension providers (#2732) | docs/agents.md,src/runs/foreground/execution.ts,src/runs/shared/child-session.ts |
| `ecc9bc41` | SKIP | fix: end blocking bg_wait when the operator sends a message (#2736) | blocking bg_wait tool is removed |
| `026f6ee0` | DEFER | ci: install bubblewrap from the runner's Ubuntu mirror (#2740) | not ported in this checkpoint |
| `542cf504` | TAKE | fix(schedules): allow a symlinked ~/.pi when Pi runs in the home directory (#2739) | cherry-picked and typechecked |
| `588d2cfd` | DEFER | feat(tui): add a one-line-per-run layout for the async widget (#2738) | not ported in this checkpoint |
| `f318c82e` | DEFER | feat: show the provider in subagent model displays (#2734) | not ported in this checkpoint |
| `dbd40216` | ADAPT | fix: write result indexes before the result becomes readable (#2743) | src/shared/atomic-json.ts |
| `ed942575` | DEFER | fix: keep subagent program status records alongside Pi's own OSC 7501 reports (#2746) | not ported in this checkpoint |
| `4c63aa07` | ADAPT | fix: keep extension prompt sections in child provider requests (#2747) | src/runs/shared/child-session.ts,test/integration/in-process-child.test.ts |
| `0c33ec7c` | DEFER | test: confine external-cli runner test failures to the failing test (#2749) | not ported in this checkpoint |
| `8323c6d5` | DEFER | docs: say where project-wide schedules fire and how to keep them in one session (#2754) | not ported in this checkpoint |
| `699429b4` | DEFER | feat(tui): show subagent messages as Pi's own message block (#2753) | not ported in this checkpoint |
| `1325e95a` | DEFER | fix: let workflow emit() accept undefined fields like return does (#2755) | not ported in this checkpoint |
| `448a395a` | TAKE | test: pin the clock in the async widget coverage reuse test (#2756) | cherry-picked and typechecked |
| `ad11b7ab` | DEFER | fix: keep a run's final result when a consumer of its paused result cleans up (#2757) | not ported in this checkpoint |
| `bfd34a10` | DEFER | perf: cap child output inlined into parent results (#2779) | not ported in this checkpoint |
| `76c4e39b` | ADAPT | perf: keep each session on the tool definitions it already declared (#2781) | pin tool declarations without reinstating activation |
| `b8f58f18` | SKIP | perf: shrink bg_wait tool text sent on every request (#2777) | bg_wait tool is removed |
| `45a76cdb` | DEFER | perf: serve guide topics as a table of contents or one section (#2782) | not ported in this checkpoint |
| `35a667c0` | ADAPT | test: give child-commands process waits room on loaded Windows runners (#2784) | test/unit/child-commands.test.ts |
| `68cccb5f` | SKIP | perf: move subagent management fields into one options object (#2786) | upstream management options surface is intentionally absent |
| `22e513fe` | ADAPT | perf: cut the default subagent tool description to its essentials (#2787) | tool description can be optimized only within fork safety kernel |
| `45a2218d` | SKIP | feat: add a built-in parallel named workflow for independent fan-out (#2789) | named workflow model API remains intentionally removed |
| `1f1f047b` | DEFER | test: tighten the per-request package tool text budget and name each tool's size (#2790) | not ported in this checkpoint |
| `d7ac44bd` | DEFER | perf: return valid agents and models in launch errors instead of requiring discovery calls (#2792) | not ported in this checkpoint |
| `f393d204` | TAKE | fix: give the detached runner's dispatcher Pi's 2 s connection attempt timeout (#2794) | cherry-picked and typechecked |
| `bda7cf35` | DEFER | fix: run workflows when the host freezes Promise.prototype.then (#2793) | not ported in this checkpoint |
| `d72e4c34` | SKIP | fix: send the parent session id with pruned fork summary requests (#2795) | fork-context summarization is removed |
| `c1fb3dce` | DEFER | fix: keep the recorded advertised-agents introduction and drop its list-first instruction (#2798) | not ported in this checkpoint |
| `051fd26e` | TAKE | fix: use component screens only in TUI mode so RPC hosts get the select and text fallbacks (#2796) | cherry-picked and typechecked |
| `e3592bb1` | DEFER | perf: trim repeated text from the bundled role prompts (#2799) | not ported in this checkpoint |
| `467393eb` | DEFER | fix: resolve runtime extension siblings from disk, not the caller's extension (#2761) | not ported in this checkpoint |
| `9fa4c16f` | DEFER | feat: attach run ids and paths to subagent-notify details (#2797) | not ported in this checkpoint |
| `c49012e0` | DEFER | feat: record the parent session on subagent runs (#2800) | not ported in this checkpoint |
| `6a7ae65b` | TAKE | fix: find typebox/compile through the running Pi for structured output validation (#2801) | cherry-picked and typechecked |
| `23f09945` | TAKE | fix: find missions when cwd reaches the project through a symlink (#2785) | cherry-picked and typechecked |
| `0f8ec787` | DEFER | fix(controls): keep interrupts scoped to the requested run (#2760) | not ported in this checkpoint |
| `eb91202f` | DEFER | fix: stop detached foreground children when the pi-subagents runtime is replaced (#2802) | not ported in this checkpoint |
| `30a13205` | ADAPT | fix: ignore project subagent settings, agents and packages when the session declined project trust (#2803) | project trust must gate fork discovery and public dispatch |
| `005a380e` | ADAPT | fix: read no project settings during discovery when the session declined project trust (#2805) | untrusted-project settings must not be read; adapt fork discovery |
| `bc078467` | DEFER | refactor: trim redundant tests and dead code from the unreleased changes (#2808) | not ported in this checkpoint |
| `b513dc4b` | ADAPT | fix: share one idle wake with pi-intercom so concurrent wakes don't fail (#2809) | src/shared/parent-wake.ts,test/unit/parent-wake.test.ts |
| `c7a927f0` | ADAPT | fix(schedules): release a schedule's claim when its async run is dead (#2810) | src/runs/background/scheduled-runs.ts |
| `1ac9b964` | SKIP | chore(release): v0.77.0 | upstream version/publish identity is not fork identity |
| `29bc37c3` | DEFER | fix: resume after manual compaction through the prompt lifecycle (#2812) | not ported in this checkpoint |
| `ea9a32fc` | TAKE | fix: name the permitted values when structured output fails an enum or const (#2815) | cherry-picked and typechecked |
| `df6d2b98` | ADAPT | fix: stop repeated control inbox errors from flooding the runner log (#2816) | src/runs/background/control-channel.ts |
| `5808e941` | DEFER | feat: hold background subagent wakes after Esc and add stop all (#2817) | not ported in this checkpoint |
| `29284cd9` | DEFER | fix: keep the output path out of the child system prompt (#2818) | not ported in this checkpoint |
| `ca7162e7` | DEFER | refactor: deslop the unreleased changes (#2819) | not ported in this checkpoint |
| `69673c7f` | TAKE | fix: name virtual models and the host remedy in the child model-not-found diagnostic (#2821) | cherry-picked and typechecked |
| `cc5cb232` | DEFER | fix: report the model a routed async child actually ran on (#2825) | not ported in this checkpoint |
| `5852aa08` | DEFER | fix: use neutral wording when a background subagent is stopped (#2827) | not ported in this checkpoint |
| `f10b4c20` | DEFER | fix: run workflows that call Promise.all when the host freezes Promise (#2828) | not ported in this checkpoint |
| `24bc7af6` | TAKE | test: fix two flaky CI tests (stale advertisement lookup wait, teardown ENOTEMPTY) (#2833) | cherry-picked and typechecked |
| `db9e5ed1` | DEFER | fix: show a timed-out background child's partial output in its notice (#2830) | not ported in this checkpoint |
| `026f5e62` | DEFER | feat: opt-in prompt section listing active background subagent runs (#2834) | not ported in this checkpoint |
| `6f4820f5` | DEFER | refactor: tidy code merged since the last cleanup pass (#2836) | not ported in this checkpoint |
| `b6c7943c` | DEFER | fix: show workflow validation warnings as a TUI notice in interactive sessions (#2838) | not ported in this checkpoint |
| `45891397` | DEFER | fix: write an output-less resume to a fresh path instead of the original run's output (#2840) | not ported in this checkpoint |
| `fee02048` | TAKE | fix: accept Unicode spaces in external-run session and run ids (#2843) | cherry-picked and typechecked |
| `c52db323` | TAKE | fix: show fleet external-run warnings once through the TUI instead of console.warn (#2845) | cherry-picked and typechecked |
| `8fcc3c78` | DEFER | fix: give a workflow resume of an outside run its own report path (#2842) | not ported in this checkpoint |
| `daf1027b` | SKIP | feat: let a forked subagent reuse its parent's prompt cache (#2857) | fork-parent context and cache sharing are removed |
| `82a69a1a` | DEFER | fix: stop notifying a dynamic launch count on every workflow run (#2860) | not ported in this checkpoint |
| `31022abc` | ADAPT | fix: require chord aliases only when the Pi host declares chord (#2855) | .github/workflows/test.yml,src/runs/background/runner-aliases.ts,test/smoke/clean-install.mjs |
| `7e0e285c` | DEFER | docs: state the clean-checkout requirement for worktree: true in the skill (#2861) | not ported in this checkpoint |
| `2771b513` | ADAPT | fix(slash): let hosts that render ctx.ui.custom over RPC pass the component gate (#2849) | docs/extension-api.md |
| `3f79ee7b` | ADAPT | test: stop the schedule history race test from racing the lease wait (#2867) | test/fixtures/schedule-history-writer.mjs,test/unit/schedule-history-transactions.test.ts |
| `82b1c048` | DEFER | feat: add pinToolDeclarations to let resumed sessions pick up current tool definitions (#2853) | not ported in this checkpoint |
| `a35c9408` | TAKE | fix: declare the builtin read-only agents' acceptance role (#2868) | cherry-picked and typechecked |
| `cf13c6e1` | DEFER | refactor: stop writing run-history.jsonl (#2869) | not ported in this checkpoint |
| `7dc204ec` | ADAPT | fix: publish validated structured output to bound file-only paths (#2850) | file-only validated output requires fork outputSchema adaptation |
| `e28d10ea` | ADAPT | fix: release a workflow's capacity slot when an async child fails to launch (#2858) | docs/configuration.md |
| `86e25e17` | DEFER | fix: read tool results from the toolResult messages Pi emits (#2871) | not ported in this checkpoint |
| `aa9c514e` | DEFER | ci: give the clean-install smoke's host install seven minutes (#2872) | not ported in this checkpoint |
| `1455d3e8` | TAKE | fix: release a finished workflow's slot when a stopped or completed child's runner is dead (#2873) | cherry-picked and typechecked |
| `59ce1b2b` | DEFER | refactor: drop the remaining tool_result_end handling (#2877) | not ported in this checkpoint |
| `4cafe20a` | DEFER | fix: report hard-reached until a tool call is actually blocked (#2876) | not ported in this checkpoint |
| `a4c8ced6` | SKIP | chore(release): v0.78.0 | upstream version/publish identity is not fork identity |
| `2d4b86a4` | DEFER | fix: restore async widgets after a mid-run auto-compaction (#2891) | not ported in this checkpoint |
| `185db321` | TAKE | fix: name pending supervisor requests when a reply targets a gone one (#2895) | cherry-picked and typechecked |
| `e5f98a86` | DEFER | fix: key mutating tool failure detection on isError and exempt /dev/null redirects (#2881) | not ported in this checkpoint |
| `54f96b1b` | DEFER | fix: pin tool descriptions without the note a host appends (#2899) | not ported in this checkpoint |
| `170e2fb6` | ADAPT | fix: keep a supervisor ask alive while its notice waits behind a busy parent (#2900) | src/intercom/native-supervisor-channel.ts |
| `87def4a3` | ADAPT | fix: retry result cleanup silently while a runner holds the run lease (#2897) | src/runs/background/result-files.ts,src/runs/background/result-watcher.ts,src/shared/file-lease.ts,test/unit/file-lease.test.ts,test/unit/result-files.test.ts |
| `029c7521` | DEFER | docs: say which pi-subagents tools codemode scripts cannot call (#2898) | not ported in this checkpoint |
| `fc73d746` | DEFER | fix: let extensions detect the async runner process via PI_SUBAGENT_RUNNER_PID (#2885) | not ported in this checkpoint |
| `02dc327b` | DEFER | feat: report each step's model in the RPC async-status snapshot (#2893) | not ported in this checkpoint |
| `a85a8b50` | SKIP | fix: let forked subagents reuse the parent's prompt cache (#2879) | fork-parent context and cache sharing are removed |
| `667d6904` | ADAPT | test: wait for a cancelled command's process before removing its cwd (#2902) | test/unit/command-action.test.ts |
| `ed66e1eb` | DEFER | Fix misleading command suggestions in open-tool notices (#2882) | not ported in this checkpoint |
| `2ac33ce1` | DEFER | refactor: deslop unreleased changes since v0.78.0 (#2903) | not ported in this checkpoint |

## Disposition totals

- **TAKE: 38**, **ADAPT: 30**, **SKIP: 15**, **DEFER: 111** across **194** upstream non-merge commits.
- Status refers to code porting and first-order TypeScript evidence, not a claim that all upstream changes through v0.78.0 have been integrated.
- Both complete test suites have been run against the checkpoint; see results below.

## Test results

- `npm run typecheck`: **pass** after all code changes.
- Fork-boundary focused gate: **109 passed, 0 failed**.
- `npm run test:unit`: **3,877 passed, 0 failed, 15 skipped** (3,892 tests).
- `npm run test:integration`: **1,074 passed, 0 failed, 8 skipped** (1,082 tests).
- `npm run test:all`: **exit code 0**.
- No full-tree merge was finalized; this is an incremental checkpoint until ADAPT and DEFER items are resolved.
