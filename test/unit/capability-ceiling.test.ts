import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	intersectSubagentCapabilityCeilings,
	resolveCurrentSubagentCapabilityCeiling,
	parseSubagentCapabilityCeiling,
	registerSubagentCapabilityCeiling,
	resolveSubagentCapabilityCeiling,
} from "../../src/api/capability-ceiling.ts";
import {
	intersectOperatorAllowedTools,
	normalizeOperatorAllowedTools,
} from "../../src/runs/shared/capability-ceiling.ts";
import { resolveOperatorCeiling } from "../../src/runs/shared/child-tool-plan.ts";

describe("subagent capability ceiling", () => {
	it("intersects active registrations for an exact session", () => {
		const sessionId = `cap-${Date.now()}-${Math.random()}`;
		const first = registerSubagentCapabilityCeiling({ sessionId, source: "plan", ceiling: { allowedTools: ["read", "grep", "write"] } });
		const second = registerSubagentCapabilityCeiling({ sessionId, source: "review", ceiling: { allowedTools: ["read", "grep"], denyExtensions: true } });
		assert.deepEqual(resolveSubagentCapabilityCeiling(sessionId), {
			version: 1,
			allowedTools: ["grep", "read"],
			denyExtensions: true,
			sources: ["plan", "review"],
		});
		assert.equal(resolveSubagentCapabilityCeiling(`${sessionId}-other`), undefined);
		second.dispose();
		first.dispose();
	});

	it("keeps explicit empty allowlists distinct from unrestricted state", () => {
		const ceiling = intersectSubagentCapabilityCeilings({ version: 1, allowedTools: [], denyExtensions: false, sources: ["test"] });
		assert.deepEqual(ceiling?.allowedTools, []);
		assert.equal(intersectSubagentCapabilityCeilings(), undefined);
	});

	it("rejects malformed policy and disposed updates", () => {
		assert.throws(() => registerSubagentCapabilityCeiling({ sessionId: "x", source: "x", ceiling: {} }), /allowedTools, allowedAgents, or denyExtensions/);
		const handle = registerSubagentCapabilityCeiling({ sessionId: "disposed", source: "test", ceiling: { denyExtensions: true } });
		handle.dispose();
		assert.throws(() => handle.update({ allowedTools: ["read"] }), /disposed/);
	});

	it("normalizes the operator allowlist with dumb validation only", () => {
		assert.deepEqual(normalizeOperatorAllowedTools(undefined), undefined);
		assert.deepEqual(normalizeOperatorAllowedTools([]), undefined);
		assert.deepEqual(normalizeOperatorAllowedTools(["read", "read", "Grep"]), ["read", "Grep"]);
		assert.throws(() => normalizeOperatorAllowedTools("read"), /expected an array/);
		assert.throws(() => normalizeOperatorAllowedTools(["read", " "]), /non-empty strings/);
	});

	it("intersects operator allowlist with agent grants as dumb arithmetic", () => {
		assert.deepEqual(intersectOperatorAllowedTools(["read", "bash"], undefined), { effective: ["read", "bash"], removed: [] });
		assert.deepEqual(intersectOperatorAllowedTools(["Read", "bash", "write"], ["read", "bash"]), {
			effective: ["Read", "bash"],
			removed: ["write"],
		});
	});

	it("does not inherit parent ceilings; settings apply uniformly per launch", () => {
		// Authority simplification: nested/async parent→child restriction
		// inheritance is deleted. The settings list resolves fresh per launch.
		const sessionId = `current-${Date.now()}-${Math.random()}`;
		const handle = registerSubagentCapabilityCeiling({ sessionId, source: "local", ceiling: { allowedTools: ["grep", "read"] } });
		try {
			assert.deepEqual(resolveSubagentCapabilityCeiling(sessionId), {
				version: 1,
				allowedTools: ["grep", "read"],
				denyExtensions: false,
				sources: ["local"],
			});
			assert.deepEqual(resolveCurrentSubagentCapabilityCeiling(sessionId), {
				version: 1,
				allowedTools: ["grep", "read"],
				denyExtensions: false,
				sources: ["local"],
			});
			assert.deepEqual(resolveOperatorCeiling(["read"], undefined), {
				version: 1,
				allowedTools: ["read"],
				denyExtensions: false,
				sources: ["settings:subagents.allowedTools"],
			});
			assert.equal(resolveOperatorCeiling(undefined, undefined), undefined);
		} finally {
			handle.dispose();
		}
	});

	it("still rejects malformed persisted ceilings", () => {
		assert.throws(() => parseSubagentCapabilityCeiling({ version: 1, allowedTools: ["read"], denyExtensions: true }), /sources/);
		assert.throws(() => parseSubagentCapabilityCeiling({ version: 2, allowedTools: ["read"], denyExtensions: true, sources: ["plan"] }), /version/);
	});
});
