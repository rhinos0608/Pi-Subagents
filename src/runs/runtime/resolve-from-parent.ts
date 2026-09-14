/** ESM-only `import.meta.resolve` helper (unavailable under `new Function`). */
export function resolveFromParent(specifier: string, parentUrl: string): string {
	// eslint-disable-next-line @typescript-eslint/no-implied-eval -- import.meta.resolve has no sync CJS equivalent.
	return import.meta.resolve(specifier, parentUrl);
}
