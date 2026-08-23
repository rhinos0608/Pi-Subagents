Implemented output-routing removal across public/config surfaces.

Changed files: 17 listed files, including schemas, agents, serializers, execution paths, settings, slash parsing, and agent markdown.

Validation:
- `npx tsc --noEmit` passed.
- `npm run test:unit` ran; legacy tests fail because they assert removed output behavior.
- `git diff --check` passed.
- No staged files.