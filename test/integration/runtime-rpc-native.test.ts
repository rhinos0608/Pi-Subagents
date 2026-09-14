/**
 * Native compatibility spike. Under the installed test shim these red checks
 * must HOLD (fail-closed): no ready, no exact-model proof, no token-cap
 * proof. Host 0.85.1 is proven by the unit native suite
 * (`test/unit/runtime-rpc-native-host.test.ts`: one real prompt end-to-end
 * with a synthetic provider, exact cap enforced); this file keeps the
 * shim fail-closed checks.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VERIFIED_RUNTIME_HOST_VERSIONS } from "../../src/api/runtime-rpc.ts";
import { isRuntimeGateOpen } from "../../src/extension/runtime-rpc.ts";
import { isVerifiedHostVersion, probeRealLeafHost } from "../../src/runs/runtime/leaf-model-session.ts";

const NATIVE_SDK = process.env.PI_SUBAGENTS_NATIVE_SDK;

describe("runtime native compatibility spike", () => {
	it("shim host proves nothing: probe returns null", async () => {
		assert.equal(await probeRealLeafHost(), null);
	});

	it("proven host version allowlisted", () => {
		assert.ok([...VERIFIED_RUNTIME_HOST_VERSIONS].includes("0.85.1"));
	});

	it("gate closed for shim and current dev versions", () => {
		assert.equal(isVerifiedHostVersion("0.0.0-pi-subagents-test-shim"), false);
		assert.equal(isRuntimeGateOpen("0.0.0-pi-subagents-test-shim"), false);
		assert.equal(isRuntimeGateOpen("0.81.0"), false);
	});

	it("native SDK root absent: exact token-cap proof pending", () => {
		if (NATIVE_SDK) {
			assert.ok(typeof NATIVE_SDK === "string" && NATIVE_SDK.length > 0);
			return;
		}
		// Without a verified host root, outbound cap assertion, zero-tool leaf
		// isolation, and abort/idle settlement stay unproven by construction.
		assert.equal(NATIVE_SDK, undefined);
	});
});
