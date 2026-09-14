import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	permissionArgsPreview,
	permissionDecision,
	resolvePermissionRules,
	validatePermissionConfig,
	validatePermissionRules,
} from "../../src/runs/shared/permissions.ts";

describe("native child permissions", () => {
	it("defaults every unconfigured tool and bash to pass-through", () => {
		assert.equal(permissionDecision(undefined, "write"), "allow");
		assert.equal(permissionDecision({ write: "deny" }, "unknown_tool"), "allow");
		assert.equal(permissionDecision({ write: "deny" }, "bash"), "allow");
		assert.equal(resolvePermissionRules(), undefined);
	});

	it("merges explicit global and agent rules while removing explicit allow rules", () => {
		assert.deepEqual(resolvePermissionRules(
			{ rules: { write: "ask", edit: "deny" } },
			{ write: "allow", read: "deny" },
		), { edit: "deny", read: "deny" });
	});

	it("rejects bash and coordination-tool rules", () => {
		assert.throws(() => validatePermissionRules({ bash: "ask" }, "permissions"), /pi-guard/);
		assert.throws(() => validatePermissionRules({ contact_supervisor: "deny" }, "permissions"), /reserved for child coordination/);
		assert.throws(() => validatePermissionConfig({ rules: { write: "sometimes" } }), /allow, ask, or deny/);
	});

	it("matches rule keys case-insensitively so label spellings cannot evade deny/ask", () => {
		assert.equal(permissionDecision({ dangerous: "deny" }, "Dangerous"), "deny");
		assert.equal(permissionDecision({ Browser: "ask" }, "browser"), "ask");
		assert.equal(permissionDecision({ write: "deny" }, "WRITE"), "deny");
		assert.equal(permissionDecision({ write: "deny" }, "read"), "allow");
		assert.equal(permissionDecision({ write: "deny" }, "bash"), "allow");
	});

	it("rejects case-variant bash and coordination-tool rules", () => {
		assert.throws(() => validatePermissionRules({ Bash: "ask" }, "permissions"), /pi-guard/);
		assert.throws(() => validatePermissionRules({ Contact_Supervisor: "deny" }, "permissions"), /reserved for child coordination/);
	});

	it("redacts bounded argument previews", () => {
		const preview = permissionArgsPreview({ token: "secret-value", content: `Bearer abcdefghijklmnop ${"x".repeat(3000)}` });
		assert.doesNotMatch(preview, /secret-value|abcdefghijklmnop/);
		assert.ok(Buffer.byteLength(preview) <= 2048);

		const multibytePreview = permissionArgsPreview({ content: Array.from({ length: 10 }, () => "😀".repeat(300)) });
		assert.ok(Buffer.byteLength(multibytePreview, "utf-8") <= 2048);
		assert.doesNotMatch(multibytePreview, /�/);
		assert.match(multibytePreview, /…$/);
	});

	it("redacts common credential key names and secret formats", () => {
		const preview = permissionArgsPreview({
			accessKey: "AKIAIOSFODNN7EXAMPLE",
			privateKey: "-----BEGIN RSA PRIVATE KEY----- MIIE",
			clientSecret: "client-secret-value",
			note: "temp ASIAIOSFODNN7EXAMPLE key",
		});
		assert.doesNotMatch(preview, /AKIAIOSFODNN7EXAMPLE|ASIAIOSFODNN7EXAMPLE|client-secret-value|BEGIN RSA PRIVATE KEY/);
		assert.match(preview, /\[redacted\]/);
	});

	it("redacts a complete PEM block under a non-secret key", () => {
		const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7b\n-----END RSA PRIVATE KEY-----";
		const preview = permissionArgsPreview({ note: pem });
		assert.doesNotMatch(preview, /BEGIN RSA PRIVATE KEY|MIIEpAIBAAKCAQEA7b|END RSA PRIVATE KEY/);
		assert.match(preview, /\[redacted\]/);
	});
});
