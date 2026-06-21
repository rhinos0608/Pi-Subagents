import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	applySubagentProfile,
	checkSubagentProfile,
	DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS,
	generateProfilesForProvider,
	getProviderModelsPath,
	getSubagentProfilesDir,
	listSubagentProfiles,
	refreshProviderModelCatalog,
	readProviderModelCatalog,
} from "../../src/profiles/profiles.ts";

let homeDir = "";
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;

function makeCtx(cwd: string, models: Array<Record<string, unknown>>) {
	return {
		cwd,
		modelRegistry: {
			getAvailable: () => models,
		},
	};
}

describe("profiles helpers", () => {
	beforeEach(() => {
		homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subprofiles-home-"));
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		fs.rmSync(homeDir, { recursive: true, force: true });
	});

	it("lists no profiles when the directory is empty", () => {
		assert.deepEqual(listSubagentProfiles(), []);
		assert.equal(fs.existsSync(getSubagentProfilesDir()), true);
	});

	it("applies a saved profile by replacing only settings.subagents", () => {
		const profilesDir = getSubagentProfilesDir();
		fs.mkdirSync(profilesDir, { recursive: true });
		fs.writeFileSync(path.join(profilesDir, "openai-codex.quota.json"), JSON.stringify({
			subagents: {
				agentOverrides: {
					scout: { model: "openai-codex/gpt-5.3-codex-spark" },
				},
			},
		}, null, 2));
		const settingsPath = path.join(homeDir, ".pi", "agent", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify({ defaultModel: "openai/gpt-5", subagents: { agentOverrides: { scout: { model: "old" } } } }, null, 2));

		const result = applySubagentProfile("openai-codex.quota");
		const written = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		assert.equal(result.settingsPath, settingsPath);
		assert.equal(result.filePath.endsWith("openai-codex.quota.json"), true);
		assert.equal(written.defaultModel, "openai/gpt-5");
		assert.equal(written.subagents.agentOverrides.scout.model, "openai-codex/gpt-5.3-codex-spark");
	});

	it("refreshes a provider model catalog and writes a cache file", async () => {
		const execCalls: string[] = [];
		const pi = {
			exec: async (_command: string, args: string[]) => {
				execCalls.push(args.join(" "));
				return { stdout: "OK\n", stderr: "", code: 0, killed: false };
			},
		};
		const ctx = makeCtx(process.cwd(), [
			{ provider: "openai-codex", id: "gpt-5.3-codex-spark", reasoning: true, name: "Spark" },
			{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true, name: "Mini" },
			{ provider: "openai-codex", id: "gpt-5.4", reasoning: true, name: "Base" },
			{ provider: "openai-codex", id: "gpt-5.5", reasoning: true, name: "Best" },
		]);

		const result = await refreshProviderModelCatalog(pi, ctx as never, "openai-codex");
		assert.equal(result.reused, false);
		assert.equal(fs.existsSync(result.filePath), true);
		assert.equal(result.catalog.models.length, 4);
		assert.equal(execCalls.length, 4);
		assert.deepEqual(result.catalog.models.map((entry) => entry.fullId), [
			"openai-codex/gpt-5.3-codex-spark",
			"openai-codex/gpt-5.4-mini",
			"openai-codex/gpt-5.4",
			"openai-codex/gpt-5.5",
		]);
		assert.equal(readProviderModelCatalog("openai-codex")?.provider, "openai-codex");
		assert.equal(result.heuristicFallbackCount, 4);
		assert.deepEqual(result.catalog.models[0]?.derived.classificationSources, ["heuristic-name"]);
		assert.deepEqual(result.catalog.models[0]?.warnings, ["Classification fell back to name heuristics."]);
	});

	it("does not count heuristic fallback when official metadata is present", async () => {
		const pi = {
			exec: async () => ({ stdout: "OK\n", stderr: "", code: 0, killed: false }),
		};
		const ctx = makeCtx(process.cwd(), [
			{
				provider: "openai",
				id: "gpt-5-mini",
				name: "GPT-5 Mini",
				reasoning: true,
				contextWindow: 128000,
				maxTokens: 16000,
				cost: { input: 0.25, output: 2 },
			},
			{
				provider: "openai",
				id: "gpt-5",
				name: "GPT-5",
				reasoning: true,
				contextWindow: 200000,
				maxTokens: 32000,
				cost: { input: 1.25, output: 10 },
			},
		]);
		const result = await refreshProviderModelCatalog(pi, ctx as never, "openai");
		assert.equal(result.heuristicFallbackCount, 0);
		assert.deepEqual(result.catalog.models[0]?.derived.classificationSources, ["official-metadata", "heuristic-name"]);
		assert.deepEqual(result.catalog.models[0]?.warnings, []);
	});

	it("reuses a fresh provider model catalog", async () => {
		const pi = {
			exec: async () => {
				throw new Error("should not probe fresh cache");
			},
		};
		const filePath = getProviderModelsPath("openai-codex");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify({
			provider: "openai-codex",
			refreshedAt: new Date().toISOString(),
			maxAgeDays: DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS,
			sources: ["runtime-registry"],
			models: [],
		}, null, 2));
		const result = await refreshProviderModelCatalog(pi, makeCtx(process.cwd(), []) as never, "openai-codex");
		assert.equal(result.reused, true);
	});

	it("generates quota and quality profiles from sorted provider models", async () => {
		const pi = {
			exec: async () => ({ stdout: "OK\n", stderr: "", code: 0, killed: false }),
		};
		const ctx = makeCtx(process.cwd(), [
			{ provider: "openai-codex", id: "gpt-5.3-codex-spark", reasoning: true },
			{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true },
			{ provider: "openai-codex", id: "gpt-5.4", reasoning: true },
			{ provider: "openai-codex", id: "gpt-5.5", reasoning: true },
		]);

		const result = await generateProfilesForProvider(pi, ctx as never, "openai-codex");
		assert.equal(result.heuristicFallbackCount, 4);
		assert.equal(result.selectedHeuristicFallbackCount, 4);
		assert.equal(result.quotaModels.cheap, "openai-codex/gpt-5.3-codex-spark");
		assert.equal(result.quotaModels.medium, "openai-codex/gpt-5.4-mini");
		assert.equal(result.quotaModels.strong, "openai-codex/gpt-5.4");
		assert.equal(result.qualityModels.cheap, "openai-codex/gpt-5.4-mini");
		assert.equal(result.qualityModels.medium, "openai-codex/gpt-5.4");
		assert.equal(result.qualityModels.strong, "openai-codex/gpt-5.5");
	});

	it("checks a profile against the registry and live probe", async () => {
		const profilesDir = getSubagentProfilesDir();
		fs.mkdirSync(profilesDir, { recursive: true });
		fs.writeFileSync(path.join(profilesDir, "demo.json"), JSON.stringify({
			subagents: {
				agentOverrides: {
					scout: { model: "openai-codex/gpt-5.3-codex-spark" },
					worker: { model: "openai-codex/gpt-5.9" },
				},
			},
		}, null, 2));
		const pi = {
			exec: async (_command: string, args: string[]) => {
				const model = args[2];
				if (model === "openai-codex/gpt-5.9") {
					return { stdout: "", stderr: "model unavailable", code: 1, killed: false };
				}
				return { stdout: "OK\n", stderr: "", code: 0, killed: false };
			},
		};
		const ctx = makeCtx(process.cwd(), [{ provider: "openai-codex", id: "gpt-5.3-codex-spark" }]);
		const result = await checkSubagentProfile(pi, ctx as never, "demo");
		assert.deepEqual(result.results, [
			{
				agent: "scout",
				model: "openai-codex/gpt-5.3-codex-spark",
				inRegistry: true,
				probe: { status: "ok", message: "OK" },
			},
			{
				agent: "worker",
				model: "openai-codex/gpt-5.9",
				inRegistry: false,
				probe: { status: "unavailable", message: "model unavailable" },
			},
		]);
	});
});
