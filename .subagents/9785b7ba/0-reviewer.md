## Review

- Correct:
  - Run ID validation rejects missing, malformed, extra params (`src/extension/rpc.ts:659-660`).
  - Lookup order indexed → replay/archive → async status → `not_found` is correct.
  - Foreign-session async status rejected.
  - Disposal unsubscribes both listeners and clears cache (`src/extension/rpc.ts:794-797`).
  - Imports exist and are used.
  - Response shape exposes no explicit paths/session metadata.

- Finding: **P1** `src/extension/rpc.ts:660,786` — Result output is always empty for normal persisted results. Runner stores output under `results[].output` (`src/runs/background/subagent-runner.ts:5126-5130`), but RPC reads only top-level `payload.output`. Indexed lookup and completion-event cache therefore return `outputAvailable: false`, losing child output. Fix: extract child outputs/errors or use archive before returning/cache population.

- Finding: **P1** `src/extension/rpc.ts:660` — Indexed payload session is not verified. `resultPayloadPathForSessionRun()` can resolve a shared global payload path (`src/runs/background/result-files.ts:307-309`); handler checks only payload run ID. Reused run ID across sessions can return foreign-session output. Fix: require payload `sessionId === sessionId`.

- Finding: **P1** `src/extension/rpc.ts:785-787` — Completion listener accepts malformed/non-terminal events: invalid `state` defaults to `"complete"`; run/session IDs only need be strings. It also bypasses `maxResultCacheEntries`, allowing unbounded cache growth from completion events. Validate IDs/state and apply same bounded cache insertion helper.

- Finding: **P2** `src/extension/rpc.ts:656` — `resultOutputCapChars: 0` leaks full output because `chars.slice(-0)` returns all characters. Clamp cap and explicitly return empty output for zero cap.

- Finding: **P2** `src/extension/rpc.ts:660` — Intended `no_active_session` branch is unreachable. `resolveCurrentSessionId()` throws when identity absent (`src/shared/session-identity.ts:6-9`), producing `execution_failed` instead. Catch/map identity failure if `no_active_session` is contract.

- Correct: Live non-terminal status returns `{ ready: false, state }`; absent/malformed request IDs return `invalid_params`; outcome mapping is otherwise correct.

- Residual risk: `test/unit/rpc.test.ts` contains no result-path coverage for output extraction, same-run cross-session collision, malformed completion events, or cache bounds.

- Merge verdict: **BLOCK**