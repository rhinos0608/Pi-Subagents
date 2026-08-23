## Review
- Correct: Public schema removed caller `output`/`outputMode`; runtime rejects them at `src/extension/public-execution.ts:40`.
- Correct: Internal output paths/modes, artifacts, recovery descriptors, `.output`, `outputSchema`, and dynamic expansion remain.
- Finding: **P1** `src/extension/tool-description.ts:37` still advertises caller `output`. Remove mention; retain result `.output`.
- Finding: **P1** Tests remain stale. `test/unit/public-execution.test.ts:6-47`, `test/unit/schemas.test.ts:211`, `test/unit/agent-management.test.ts:504-590`, and related output-mode tests expect removed controls. Update tests.
- Finding: **P1** Diff has 18 files, not required 17. `CHANGELOG.md` is unrelated extra. `src/extension/tool-description.ts` is missing despite stale public guidance.
- Merge verdict: **BLOCK**