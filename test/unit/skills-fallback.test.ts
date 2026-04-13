import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	clearSkillCache,
	discoverAvailableSkills,
	resolveSkills,
} from "../../skills.ts";

let tempDir = "";

function makeProjectSkill(cwd: string, name: string, body: string): void {
	const skillDir = path.join(cwd, ".pi", "skills", name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\ndescription: Test description\n---\n\n${body}\n`,
		"utf-8",
	);
}

function makeProjectPackageSkill(cwd: string, packageName: string, name: string, body: string): void {
	const packageRoot = path.join(cwd, ".pi", "npm", "node_modules", packageName);
	const skillDir = path.join(packageRoot, "skills", name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: packageName, version: "1.0.0", pi: { skills: ["./skills"] } }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${body}\n`, "utf-8");
}

describe("skills filesystem fallback", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-fallback-"));
		clearSkillCache();
	});

	afterEach(() => {
		clearSkillCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers project skills from filesystem paths", () => {
		makeProjectSkill(tempDir, "fallback-skill", "Use fallback mode.");

		const skills = discoverAvailableSkills(tempDir);
		const discovered = skills.find((skill) => skill.name === "fallback-skill");
		assert.ok(discovered, "expected fallback-skill to be discovered");
		assert.equal(discovered?.source, "project");
		assert.equal(discovered?.description, "Test description");
	});

	it("resolves and reads skill content via filesystem fallback", () => {
		makeProjectSkill(tempDir, "resolve-skill", "Run local fallback checks.");

		const { resolved, missing } = resolveSkills(["resolve-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.name, "resolve-skill");
		assert.equal(resolved[0]?.source, "project");
		assert.match(resolved[0]?.content ?? "", /Run local fallback checks\./);
	});

	it("classifies package-provided skills as project-package", () => {
		makeProjectPackageSkill(tempDir, "test-skill-package", "pkg-skill", "Use package skill.");

		const skills = discoverAvailableSkills(tempDir);
		const discovered = skills.find((skill) => skill.name === "pkg-skill");
		assert.ok(discovered, "expected pkg-skill to be discovered");
		assert.equal(discovered?.source, "project-package");
	});

	it("prefers project skills over project-package skills with the same name", () => {
		makeProjectPackageSkill(tempDir, "test-skill-package", "shared-skill", "Package version");
		makeProjectSkill(tempDir, "shared-skill", "Project version");

		const { resolved, missing } = resolveSkills(["shared-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project");
		assert.match(resolved[0]?.content ?? "", /Project version/);
	});
});
