import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChainItem, SubagentParams } from "../../src/extension/schemas.ts";

function walk(value: unknown, action: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const part of value) walk(part, action); return; }
  const record = value as Record<string, unknown>;
  action(record);
  for (const next of Object.values(record)) walk(next, action);
}

describe("strict-provider schema portability", () => {
  it("anchors regex patterns at both ends for llama.cpp grammar conversion", () => {
    for (const schema of [SubagentParams, ChainItem]) {
      walk(schema, (record) => {
        if (typeof record.pattern === "string") {
          assert.ok(record.pattern.startsWith("^") && record.pattern.endsWith("$"), `unanchored pattern: ${record.pattern}`);
        }
      });
    }
  });
  it("does not expose the deprecated keyword in internal acceptance schemas", () => {
    walk(ChainItem.properties.acceptance, (record) => assert.equal("deprecated" in record, false));
  });
});
