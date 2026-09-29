import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// FD-011: the fork publishes under its own scoped identity and the release
// workflow cannot publish from any other repository.
describe("fork release contract (FD-011)", () => {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
		name: string;
		publishConfig?: { access?: string };
	};

	it("keeps the scoped package identity", () => {
		assert.equal(pkg.name, "@rhinos0608/pi-subagents");
		assert.equal(pkg.publishConfig?.access, "public");
	});

	it("guards the release workflow to the fork repository", () => {
		const workflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf-8");
		assert.match(workflow, /github\.repository\s*==\s*['"]rhinos0608\/Pi-Subagents['"]/);
	});
});
