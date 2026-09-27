# Missions and schedules

Durable records for delegated work. Missions wrap runs so the work can be recovered later; delivery receipts link external outcomes.

Management lives in Fleet and slash commands, not the model tool. There are no `mission.*`, `schedule.*`, `project.*`, `lane.*`, or `worktree.*` model actions.

## Missions

Noun map:

- **Project/codebase** — where work happens.
- **Mission** — why delegated work exists and how to recover it later.
- **Run** — one actual subagent execution.
- **Receipt** — proof or a link for an external outcome, such as a PR, CI check, deployment, or release.

Ordinary workflow launches create one enclosing mission by default, with detailed JSON records linking objectives, run ids, lifecycle status, decisions, artifact paths, and delivery receipts. Workflow children do not create separate missions.

Behavior:

- Pass `mission: false` on a workflow launch for intentionally ephemeral work with no mission and no `state` global.
- Mission storage configuration (`missions.directory`, `retainTerminal`, `globalIndex`) is in [configuration](configuration.md#missions).
- After compaction or restart, recover from Fleet or the mission slash commands first, then use the linked run ids with normal `status`, `steer`, `resume`, or `interrupt` model actions.

### Goal missions

A goal mission with a token budget acts as a continuation driver: after idle parent turns it sends one needs-attention notice with its title, remaining budget, and next ready action. Reaching the budget stops notices without closing the mission or reporting success. The extension never launches or replans goal work by itself.

## Schedules

Timed and recurring runs are durable project records managed through slash commands and Fleet. Runs launch async; definitions, bounded history, append-only events, and per-run receipts are stored per project. Disable or bound schedules with the `scheduledRuns` config key in [configuration](configuration.md#scheduledruns).

## Cross-project work

Keep same-project tasks on ordinary subagents. Use an explicit `cwd` for small bounded work in another project. For substantial or long-running work in another project, open a project-owned session rooted there and give it a narrow mission/result contract. That session owns its own subagents; do not model it as ordinary child nesting.
