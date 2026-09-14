import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertOutboundTokenCap,
	buildLeafSessionSpec,
	cloneModelWithCap,
	executeLeafRun,
	isVerifiedHostVersion,
	LEAF_SYSTEM_PROMPT,
	resolveEffectiveCap,
	resolveExactModel,
	type AuditedLeafModel,
	type LeafHost,
} from "../../src/runs/runtime/leaf-model-session.ts";
import type { ModelInfo } from "../../src/shared/model-info.ts";

const MODELS: ModelInfo[] = [
	{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", api: "openai-responses", maxTokens: 8192 },
	{ provider: "acme", id: "gpt-5-mini", fullId: "acme/gpt-5-mini", api: "openai-responses", maxTokens: 8192 },
	{ provider: "anthropic", id: "claude-x", fullId: "anthropic/claude-x", api: "anthropic-messages", maxTokens: 4096 },
	{ provider: "openai", id: "codex-x", fullId: "openai/codex-x", api: "openai-codex-responses", maxTokens: 8192 },
];

function fakeHost(models: ModelInfo[], behavior: (spec: unknown) => Promise<{ text: string; outputTokens?: number; toolCalls: number; providerInvocations: number }>): LeafHost & { specs: unknown[]; disposed: number } {
	const host = {
		hostVersion: "9.9.9-verified-test",
		specs: [] as unknown[],
		disposed: 0,
		listModels: () => models,
		createLeafSession: async (spec: unknown) => {
			host.specs.push(spec);
			return {
				prompt: (_text: string) => behavior(spec),
				abort: async () => {},
				waitForIdle: async () => {},
				dispose: async () => {
					host.disposed += 1;
				},
			};
		},
	};
	return host;
}

describe("leaf model adapter", () => {
	it("resolves only exact provider/id matches; bare IDs and aliases fail", () => {
		const model = resolveExactModel("openai/gpt-5-mini", MODELS);
		assert.equal(model.provider, "openai");
		assert.throws(() => resolveExactModel("gpt-5-mini", MODELS), /unavailable/);
		assert.throws(() => resolveExactModel("openai/missing", MODELS), /unavailable/);
		// Two providers share a bare id; exact fullId still resolves, bare never does.
		assert.equal(resolveExactModel("acme/gpt-5-mini", MODELS).provider, "acme");
	});

	it("rejects unaudited and rejected APIs", () => {
		assert.throws(() => resolveExactModel("openai/codex-x", MODELS), /unaudited/);
		assert.throws(
			() => resolveExactModel("x/y", [{ provider: "x", id: "y", fullId: "x/y", api: "custom-gateway", maxTokens: 100 }]),
			/unaudited/,
		);
	});

	it("rejects routing metadata and unknown model maxima", () => {
		assert.throws(
			() =>
				resolveExactModel("x/y", [
					{ provider: "x", id: "y", fullId: "x/y", api: "openai-responses", maxTokens: 100, fallbackModels: ["z"] } as unknown as ModelInfo,
				]),
			/unaudited routing/,
		);
		assert.throws(() => resolveExactModel("x/y", [{ provider: "x", id: "y", fullId: "x/y", api: "openai-responses" }]), /unknown/);
	});

	it("caps effective max at min(server, model); rejects above, never clamps", () => {
		const model: AuditedLeafModel = { provider: "openai", id: "m", api: "openai-responses", maxTokens: 100 };
		assert.equal(resolveEffectiveCap(model, 100), 100);
		assert.throws(() => resolveEffectiveCap(model, 101), /exceeds/);
		assert.throws(() => resolveEffectiveCap(model, 15), /minimum/);
		const big: AuditedLeafModel = { provider: "openai", id: "m", api: "openai-responses", maxTokens: 1_000_000 };
		assert.throws(() => resolveEffectiveCap(big, 16_385), /exceeds/);
	});

	it("asserts outbound payload caps before transmission", () => {
		assertOutboundTokenCap("openai-responses", { max_output_tokens: 256 }, 256);
		assert.throws(() => assertOutboundTokenCap("openai-responses", {}, 256), /absent/);
		assert.throws(() => assertOutboundTokenCap("openai-responses", { max_output_tokens: 512 }, 256), /altered/);
		assertOutboundTokenCap("anthropic-messages", { max_tokens: 128 }, 128);
		assert.throws(() => assertOutboundTokenCap("anthropic-messages", { max_tokens: 129 }, 128), /altered/);
		assertOutboundTokenCap("openai-completions", { max_tokens: 64 }, 64);
		assert.throws(() => assertOutboundTokenCap("openai-completions", { max_tokens: 64, max_completion_tokens: 64 }, 64), /ambiguous/);
		assert.throws(() => assertOutboundTokenCap("custom-api", { max_tokens: 1 }, 1), /Unaudited/);
	});

	it("builds fresh zero-tool in-memory specs with fixed system prompt", () => {
		const model: AuditedLeafModel = { provider: "openai", id: "m", api: "openai-responses", maxTokens: 8192 };
		const spec = buildLeafSessionSpec("/repo", model, 256);
		assert.deepEqual(spec.storage, { kind: "memory" });
		assert.deepEqual(spec.tools, []);
		assert.equal(spec.ambientExtensions, false);
		assert.equal(spec.noSkills, true);
		assert.equal(spec.autoRetry, false);
		assert.equal(spec.autoCompaction, false);
		assert.equal(spec.maxTurns, 1);
		assert.deepEqual(spec.initialHistory, []);
		assert.equal(spec.systemPrompt, LEAF_SYSTEM_PROMPT);
		assert.equal(spec.model.maxTokens, 256);
		assert.equal(cloneModelWithCap(model, 256).maxTokens, 256);
	});

	it("executes one turn and proves positive token usage", async () => {
		const host = fakeHost(MODELS, async () => ({ text: "done", outputTokens: 10, toolCalls: 0, providerInvocations: 1 }));
		const result = await executeLeafRun(host, { modelId: "openai/gpt-5-mini", prompt: "hi", maxOutputTokens: 256, cwd: "/repo" });
		assert.equal(result.output, "done");
		assert.equal(host.disposed, 1);
		// Only the prompt reaches the model; identity never enters messages.
		assert.equal(host.specs.length, 1);
	});

	it("fails on missing/zero usage, tool use, multi-turn, and over-cap", async () => {
		const missing = fakeHost(MODELS, async () => ({ text: "x", toolCalls: 0, providerInvocations: 1 }));
		await assert.rejects(executeLeafRun(missing, { modelId: "openai/gpt-5-mini", prompt: "hi", maxOutputTokens: 256, cwd: "/r" }), /unverifiable/);
		const zero = fakeHost(MODELS, async () => ({ text: "x", outputTokens: 0, toolCalls: 0, providerInvocations: 1 }));
		await assert.rejects(executeLeafRun(zero, { modelId: "openai/gpt-5-mini", prompt: "hi", maxOutputTokens: 256, cwd: "/r" }), /unverifiable/);
		const tools = fakeHost(MODELS, async () => ({ text: "x", outputTokens: 5, toolCalls: 1, providerInvocations: 1 }));
		await assert.rejects(executeLeafRun(tools, { modelId: "openai/gpt-5-mini", prompt: "hi", maxOutputTokens: 256, cwd: "/r" }), /tools/);
		const multi = fakeHost(MODELS, async () => ({ text: "x", outputTokens: 5, toolCalls: 0, providerInvocations: 2 }));
		await assert.rejects(executeLeafRun(multi, { modelId: "openai/gpt-5-mini", prompt: "hi", maxOutputTokens: 256, cwd: "/r" }), /single-turn/);
		const over = fakeHost(MODELS, async () => ({ text: "x", outputTokens: 257, toolCalls: 0, providerInvocations: 1 }));
		await assert.rejects(executeLeafRun(over, { modelId: "openai/gpt-5-mini", prompt: "hi", maxOutputTokens: 256, cwd: "/r" }), /exceed/);
	});

	it("never verifies shim or unlisted hosts", () => {
		assert.equal(isVerifiedHostVersion("0.0.0-pi-subagents-test-shim"), false);
		assert.equal(isVerifiedHostVersion("0.81.0"), false);
		assert.equal(isVerifiedHostVersion(""), false);
	});
});
