## Review

- Correct: RPC method registration, session-scoped indexed lookup, cache bounds, disposal, ID validation, terminal-state mapping.
- Correct: `test/unit/rpc-result.test.ts` covers validation, session isolation, cache eviction, truncation, pending states.
- Finding: **P1** — `src/extension/rpc.ts:784-790`. Completion events provide child `summary`, not `output` (`src/runs/background/result-watcher.ts:568-577`). Listener caches empty output; later `result` hits cache after result file deletion. Fix cache extraction from `summary`/child output or defer cache lookup.
- Finding: **P1** — `src/extension/rpc.ts:660`. Replay/archive paths are read and concatenated without bounded file reads. Large artifacts/session files cause unbounded allocation before output cap. Fix bounded tail reader.
- Finding: **P1** — `src/agents/agents.ts:1799-1802`, `src/agents/agent-serializer.ts:144-155`. Legacy agent frontmatter `output`/`outputMode` enters `extraFields` and serializer emits it again. Strip/reject these keys explicitly.
- Finding: **P2** — `src/extension/rpc.ts:656`. `resultOutputCapChars: 0` returns one character for non-empty output (`Math.max(1, cap)`). Add non-empty zero-cap test and return empty output.
- Finding: **P2** — RPC result docs stale: `docs/extension-api.md:26` omits `result`; capability notes omit result details.
- Residual risk: RPC result tests lack completion-event, replay, disposal, and large-artifact coverage.

**Merge verdict: BLOCK**