Implemented removal of obsolete `output`/`outputMode` test expectations.

Changed files: 10 unit tests, including schema, agent management/overrides, RPC, preflight, chain, slash, steering.

Validation:
- `npx tsc --noEmit` passed
- `npm run test:unit`: 2365 passed, 1 pre-existing failure (`agent frontmatter defaultContext`)
- `git diff --check` passed
- No staged files