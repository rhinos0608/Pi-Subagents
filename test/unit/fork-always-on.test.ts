import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// FD-007: the subagent tool is always registered; there is no
// subagents_enable activation ceremony and no bg_wait tool.
describe("fork always-on tool (FD-007)", () => {
	it("registers subagent on load with no activation step", async () => {
		const home = process.env.PI_CODING_AGENT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-always-on-"));
		const cwd = path.join(home, "project");
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		const registered: string[] = [];
		const pi = new Proxy({
			events: { on() { return () => {}; }, emit() {} },
			on() {},
			registerTool(value: { name: string }) { registered.push(value.name); },
		}, { get(target, key) { return key in target ? (target as Record<string, unknown>)[key] : () => undefined; } });
		const { default: register } = await import("../../src/extension/index.ts");
		register(pi as never);
		assert.ok(registered.includes("subagent"), "subagent tool registered synchronously");
		assert.ok(!registered.includes("subagents_enable"), "no activation tool registered");
		assert.ok(!registered.includes("bg_wait"), "no bg_wait tool registered");
	});
});
