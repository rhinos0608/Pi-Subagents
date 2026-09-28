# Models

How subagents pick models, and how to change that.

Builtin agents inherit your current Pi default model. This keeps new installs from depending on a provider you may not have configured. From there, models resolve from agent definitions plus operator config:

- `subagents.defaultModel` — a default for every subagent that does not set its own model.
- `subagents.defaultProvider` — a provider preference for bare model ids when multiple providers expose the same id.
- `subagents.agentOverrides.<name>.model` — pin one role.
- `subagents.agentOverrides.<name>.defaultProvider` — choose or clear the provider preference for one role.

Precedence, strongest first: `agentOverrides.<name>.model` → agent frontmatter `model` → `subagents.defaultModel` → the parent session model. A provider preference does not replace this order; it only resolves bare model ids when the active registry has more than one match. Fully qualified `provider/model` strings still win exactly.

There are no per-call model or thinking parameters on the `subagent` tool. One launch walks an ordered candidate list: the resolved primary model plus the agent's configured `fallbackModels`. The walk is stateless (every launch starts at candidate zero) and bounded: up to 3 attempts per candidate with ~500ms then ~1500ms backoff, advancing on retryable startup/availability failures (rate limits, quota/billing, auth, network, overload, 5xx). Once the child has run tools, the outcome is terminal and never retried on another model.

Use `model: "inherit"` in agent frontmatter or `agentOverrides.<name>.model` to select the current parent session model explicitly.

## Setting defaults and overrides

Provenance: the flat `agentOverrides` operator layer is kept deliberately (supervisor decision) so an operator can disable, enable, and tune a role without forking shared or package-owned definitions. The provider-scoped override layer stays deleted.

In `~/.pi/agent/settings.json` (user) or the project config settings file (`.pi/settings.json` in standard Pi; project wins):

```json
{
  "defaultModel": "deepseek-v4-pro",
  "subagents": {
    "defaultModel": "deepseek-v4-flash",
    "defaultProvider": "gpu-a",
    "agentOverrides": {
      "oracle": {
        "model": "deepseek-v4-pro"
      },
      "worker": {
        "defaultProvider": "gpu-b"
      }
    }
  }
}
```

For a persistent role override:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high"
      }
    }
  }
}
```

`subagents.defaultModel` and `subagents.defaultProvider` apply to builtin, package, user, project, and runtime-registered agents. `defaultModel` fills only agents that do not set `model` in frontmatter or in their runtime definition. The same `agentOverrides` block can change `tools`, `skills`, inherited context, prompt text, or disable an agent (see [agents](agents.md)); matching custom-agent frontmatter is replaced for any field set by the override. Runtime-registered agents take only `model`, `defaultProvider`, and `thinking` from `agentOverrides.<name>`; their other definition fields stay owned by the registering extension.

Accepted gap: these global default-model settings have no Fleet writer. Hand-edit the settings file to change them.

## Recommended model tiering (optional)

A setup that works well in practice: route agents by task shape instead of running everything on one model. Four tiers:

1. **Fast workhorse** — the cheapest capable model at low thinking, for recon, lookups, and mechanical edits.
2. **Standard well-scoped** — a mid-tier model at medium thinking, for most delegations: routine multi-file edits, focused reviews, straightforward implementation.
3. **Deep but bounded** — a top reasoning model at high thinking, only for hard tasks that arrive with explicit goals and completion criteria. These models tend to loop on vague goals, so keep them off open-ended work.
4. **Taste and intent** — a model that reads human intent well and makes judgment calls without looping, for ambiguous work: UX and design decisions, product tradeoffs, planning from vague requirements, writing quality.

The routing rule: use the capability tiers (1–3) when the task is well-scoped, and the intent tier (4) when scoping or judging is the task itself. Put the assignments in agent definitions or `agentOverrides`, not in per-call parameters.

Each launch walks the ordered candidate list and starts the child on the first candidate that starts. Only retryable startup/availability failures advance the walk; a child that started executing keeps its outcome, and context-overflow never retries. When every candidate burns its attempts, the launch fails with the configured-candidate diagnostic instead of selecting an unconfigured model.

## Thinking level defaults

Set `subagents.defaultThinking` to give builtin, package, user, and project agents without a `thinking` value a shared thinking level, independent of the parent session's default. Project settings win over user settings. Matching `agentOverrides.<name>.thinking` replaces frontmatter; otherwise explicit frontmatter remains in effect. `thinking: false` remains an explicit opt-out:

```json
{
  "subagents": {
    "defaultThinking": "medium",
    "agentOverrides": {
      "reviewer": { "thinking": "high" }
    }
  }
}
```

If your provider rejects model IDs with thinking suffixes, set `subagents.disableThinking: true` in user or project settings. That clears bundled builtin thinking defaults in one place. An explicit higher-precedence `agentOverrides.<name>.thinking` value can opt a role back in or replace custom-agent frontmatter thinking.

### Thinking ceiling

Set `subagents.maxThinking` to enforce a hard maximum for every native Pi child. The supported levels, from least to most thinking, are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`:

```json
{
  "subagents": {
    "defaultThinking": "medium",
    "maxThinking": "xhigh"
  }
}
```

Requests above the ceiling fail before child startup; the setting covers frontmatter, `agentOverrides`, and resumed children. Project settings take precedence over user settings. External runners retain their existing behavior.

## Extension defaults

Set `subagents.defaultExtensions` to give builtin, package, user, and project agents without an `extensions` field a shared extension allowlist:

- Absent: preserves Pi's normal ambient extension discovery.
- Empty array: sets `extensions: []` for agents that do not explicitly define it, disabling ambient extension loading.
- Non-empty array: supplies that allowlist to agents that do not explicitly define one.

Project settings win over user settings. Use `agentOverrides.<name>.extensions` for per-agent settings; a matching override replaces custom-agent frontmatter for that field.

```json
{
  "subagents": {
    "defaultExtensions": [],
    "agentOverrides": {
      "researcher": {
        "extensions": ["./tools/research.ts"]
      }
    }
  }
}
```

## Inspecting the live mapping

To see what `pi-subagents` has actually loaded right now:

```text
/subagents-models
/subagents-models reviewer
```

That reports the live runtime mapping, which can differ from settings on disk until you reload Pi.

## Fuzzy model matching

You do not have to spell a model exactly. Model ids are matched fuzzily against the registry, so these all resolve to the same model:

- Provider separator variations: `anthropic/claude-sonnet-4`, `anthropic:claude-sonnet-4`, `anthropic.claude-sonnet-4`
- Id separator variations: `claude-haiku-4.5` vs `claude-haiku-4-5`
- Case differences: `Claude-Sonnet-4` vs `claude-sonnet-4`
- Optional trailing date stamps: `claude-haiku-4-5-20251001` or `claude-haiku-4-5-2025-10-01` vs `claude-haiku-4-5`

Exact `provider/id` matches still win, and a qualified provider query never silently switches providers — it only matches within the named provider. Ambiguous bare ids that exist under multiple providers still require a provider prefix or the current session's provider to disambiguate.

## Model scope enforcement

To keep subagents inside a budget or compliance profile, enforce a model scope. Put `subagents.modelScope` in user or project settings (project overrides user):

```json
{
  "subagents": {
    "modelScope": {
      "enforce": true,
      "strict": true,
      "allow": ["inherit", "openai/gpt-5-*", "openai-codex/gpt-5.6-*"],
      "agents": {
        "worker": { "allow": ["openai-codex/gpt-5.6-luna"] },
        "reviewer": { "allow": ["inherit"] }
      }
    }
  }
}
```

- `allow` is a list of glob patterns matched against the resolved `provider/id` (only `*` is special, case-insensitive). The literal `inherit` means the current parent session model.
- `agents.<name>` adds a second allow-list for that agent. The model must pass both the global list and the matching agent list, so an agent rule cannot weaken the global rule.
- A top-level `enforce: true` with only agent allow-lists restricts only those named agents.
- By default, models from agent frontmatter, `subagents.defaultModel`, or the inherited parent session model only warn and remain available, so existing configurations keep working while you tighten the scope.
- Set `strict: true` with `enforce: true` to reject every resolved out-of-scope model, including inherited models.
- `enforce: true` requires at least one non-empty global or agent `allow` list; otherwise the config is rejected at load time.

Model scope is policy only. It rejects or warns; it does not select a cheaper model.

`inherit` expands in the parent process at each launch. It is never sent to the child as a model id. A nested child therefore inherits its immediate parent's current model, not the original top-level model.

## Profiles and provider model catalogs

Profiles let you generate and save role-to-model assignments from a provider's live catalog. Profiles are stored under `~/.pi/agent/profiles/pi-subagents/`; provider model catalogs are cached under `~/.pi/agent/profiles/pi-subagents/providers/`. The workflow:

```text
/subagents-refresh-provider-models openai-codex
/subagents-generate-profiles openai-codex
/subagents-load-profile openai-codex.quota
```
