import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	WatchdogLspDiagnosticsLedger,
	collectWatchdogLspDiagnostics,
	formatWatchdogLspDiagnosticsBlock,
	terminateLspChild,
	watchdogWarningFromLspDiagnostics,
} from "../../src/watchdog/lsp-diagnostics.ts";
import type { WatchdogLspResult } from "../../src/watchdog/types.ts";

function result(diagnostics: WatchdogLspResult["diagnostics"]): WatchdogLspResult {
	return {
		status: "ok",
		provider: "stub-lsp",
		checkedPaths: ["src/file.ts"],
		skippedPaths: [],
		diagnostics,
	};
}

describe("watchdog LSP diagnostics", () => {
	it("formats diagnostics for watchdog review input", () => {
		const block = formatWatchdogLspDiagnosticsBlock(result([{
			path: "src/file.ts",
			line: 2,
			column: 3,
			severity: "error",
			source: "typescript",
			code: "TS2322",
			message: "Type mismatch.",
		}]));

		assert.match(block, /^LSP diagnostics:/);
		assert.match(block, /src\/file\.ts:2:3 error TS2322 typescript: Type mismatch\./);
	});

	it("omits info and hints from watchdog review input", () => {
		const block = formatWatchdogLspDiagnosticsBlock(result([{
			path: "src/file.ts",
			line: 2,
			column: 3,
			severity: "info",
			source: "typescript",
			message: "Helpful note.",
		}, {
			path: "src/file.ts",
			line: 3,
			column: 4,
			severity: "hint",
			source: "typescript",
			message: "Suggestion.",
		}]));

		assert.equal(block, "");
	});

	it("maps errors to blockers and warnings to concerns", () => {
		const blocker = watchdogWarningFromLspDiagnostics(result([{
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "error",
			source: "typescript",
			message: "Cannot find name 'x'.",
		}]));
		assert.equal(blocker?.severity, "blocker");
		assert.equal(blocker?.source, "lsp");

		const concern = watchdogWarningFromLspDiagnostics(result([{
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "warning",
			source: "typescript",
			message: "Unused value.",
		}]));
		assert.equal(concern?.severity, "concern");

		const info = watchdogWarningFromLspDiagnostics(result([{
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "info",
			source: "typescript",
			message: "Helpful note.",
		}]));
		assert.equal(info, undefined);
	});

	it("returns a failed result for malformed language-server JSON", async () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-lsp-"));
		try {
			const binDir = path.join(temp, "node_modules", ".bin");
			fs.mkdirSync(path.join(temp, "src"), { recursive: true });
			fs.mkdirSync(binDir, { recursive: true });
			fs.writeFileSync(path.join(temp, "src", "file.ts"), "export const value = 1;\n", "utf-8");
			const scriptPath = path.join(binDir, "tls-malformed.js");
			fs.writeFileSync(scriptPath, "process.stdout.write('Content-Length: 8\\r\\n\\r\\nnot-json'); setTimeout(() => process.exit(0), 50);\n", "utf-8");
			if (process.platform === "win32") {
				fs.writeFileSync(path.join(binDir, "typescript-language-server.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0\\tls-malformed.js" %*\r\n`, "utf-8");
			} else {
				const commandPath = path.join(binDir, "typescript-language-server");
				fs.writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/tls-malformed.js" "$@"\n`, { encoding: "utf-8", mode: 0o755 });
			}

			const diagnostics = await collectWatchdogLspDiagnostics({
				cwd: temp,
				root: temp,
				changedPaths: ["src/file.ts"],
				config: { enabled: true, timeoutMs: 500, maxFiles: 10, maxDiagnostics: 10 },
			});

			assert.equal(diagnostics.status, "failed");
			assert.match(diagnostics.message ?? "", /Invalid LSP JSON-RPC response/);
		} finally {
			try {
				fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			} catch (error) {
				if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			}
		}
	});

	it("suppresses repeated diagnostic identities until the file clears", () => {
		const ledger = new WatchdogLspDiagnosticsLedger();
		const diagnostic = {
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "warning" as const,
			source: "typescript",
			code: "TS6133",
			message: "Unused value.",
		};

		assert.equal(ledger.reduce(result([diagnostic])).diagnostics.length, 1);
		assert.equal(ledger.reduce(result([{ ...diagnostic, line: 4, column: 9 }])).diagnostics.length, 0);
		assert.equal(ledger.reduce(result([])).diagnostics.length, 0);
		assert.equal(ledger.reduce(result([{ ...diagnostic, line: 8 }])).diagnostics.length, 1);
	});

	it("skips symlinks that resolve outside the repo root", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-lsp-symlink-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-lsp-outside-"));
		try {
			fs.mkdirSync(path.join(root, "src"), { recursive: true });
			fs.writeFileSync(path.join(outside, "secret.ts"), "export const secret = 1;\n", "utf-8");
			fs.symlinkSync(path.join(outside, "secret.ts"), path.join(root, "src", "linked.ts"));
			const diagnostics = await collectWatchdogLspDiagnostics({
				cwd: root,
				root,
				changedPaths: ["src/linked.ts"],
				config: { enabled: true, timeoutMs: 500, maxFiles: 10, maxDiagnostics: 10 },
			});
			assert.equal(diagnostics.status, "skipped");
			assert.deepEqual(diagnostics.skippedPaths, ["src/linked.ts"]);
			assert.deepEqual(diagnostics.checkedPaths, []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("does not read a file replaced with an outside symlink after collect", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-lsp-toctou-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-lsp-outside-"));
		const filePath = path.join(root, "src", "file.ts");
		const capturePath = path.join(root, "didopen-capture.txt");
		try {
			fs.mkdirSync(path.join(root, "src"), { recursive: true });
			// Collect-time state is benign: a regular file inside the root.
			fs.writeFileSync(filePath, "export const value = 1;\n", "utf-8");
			fs.writeFileSync(path.join(outside, "secret.ts"), "export const TOCTOU_SECRET_MARKER = 1;\n", "utf-8");
			const binDir = path.join(root, "node_modules", ".bin");
			fs.mkdirSync(binDir, { recursive: true });
			// The fake server replaces the regular file with an outside symlink
			// on boot — after collect, before the host reads file text — then
			// serves minimal LSP and records any didOpen text it receives.
			const scriptPath = path.join(binDir, "tls-swap.js");
			fs.writeFileSync(scriptPath, [
				"const fs = require('node:fs');",
			"try { fs.unlinkSync(process.env.PI_TEST_LINK); } catch {}",
			"fs.symlinkSync(process.env.PI_TEST_OUTSIDE, process.env.PI_TEST_LINK);",
			"let buf = Buffer.alloc(0);",
			"function send(o) { const b = JSON.stringify(o); process.stdout.write('Content-Length: ' + Buffer.byteLength(b) + '\\r\\n\\r\\n' + b); }",
			"process.stdin.on('data', (c) => {",
			"  buf = Buffer.concat([buf, c]);",
			"  while (true) {",
			"    const h = buf.indexOf('\\r\\n\\r\\n');",
			"    if (h === -1) return;",
			"    const m = buf.slice(0, h).toString().match(/content-length:\\s*(\\d+)/i);",
			"    if (!m) { buf = buf.slice(h + 4); continue; }",
			"    const len = Number(m[1]); const s = h + 4; const e = s + len;",
			"    if (buf.length < e) return;",
			"    const msg = JSON.parse(buf.slice(s, e).toString());",
			"    buf = buf.slice(e);",
			"    if (msg.method === 'initialize' && msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });",
			"    else if (msg.method === 'shutdown' && msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: null });",
			"    else if (msg.method === 'textDocument/didOpen') { try { fs.appendFileSync(process.env.PI_TEST_CAPTURE, msg.params.textDocument.text); } catch {} }",
			"    else if (msg.method === 'exit') process.exit(0);",
			"  }",
			"});",
			"setTimeout(() => process.exit(0), 8000);",
			"",
			].join("\n"), "utf-8");
			if (process.platform === "win32") {
				fs.writeFileSync(path.join(binDir, "typescript-language-server.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0\\tls-swap.js" %*\r\n`, "utf-8");
			} else {
				const commandPath = path.join(binDir, "typescript-language-server");
				fs.writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/tls-swap.js" "$@"\n`, { encoding: "utf-8", mode: 0o755 });
			}

			process.env.PI_TEST_LINK = filePath;
			process.env.PI_TEST_OUTSIDE = path.join(outside, "secret.ts");
			process.env.PI_TEST_CAPTURE = capturePath;
			const diagnostics = await collectWatchdogLspDiagnostics({
				cwd: root,
				root,
				changedPaths: ["src/file.ts"],
				config: { enabled: true, timeoutMs: 3000, maxFiles: 10, maxDiagnostics: 10 },
			});
			assert.deepEqual(diagnostics.skippedPaths, ["src/file.ts"]);
			assert.deepEqual(diagnostics.checkedPaths, []);
			const captured = fs.existsSync(capturePath) ? fs.readFileSync(capturePath, "utf-8") : "";
			assert.ok(!captured.includes("TOCTOU_SECRET_MARKER"), "swapped-in outside content must not reach the language server");
		} finally {
			delete process.env.PI_TEST_LINK;
			delete process.env.PI_TEST_OUTSIDE;
			delete process.env.PI_TEST_CAPTURE;
			try {
				fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			} catch (error) {
				if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			}
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("kills the process tree on win32 via the platform override seam", () => {
		const previous = process.env.PI_WATCHDOG_LSP_PLATFORM_OVERRIDE;
		try {
			// Tree-kill branch: taskkill runner invoked, direct kill skipped.
			process.env.PI_WATCHDOG_LSP_PLATFORM_OVERRIDE = "win32";
			const killed: Array<string | undefined> = [];
			const pids: number[] = [];
			const child = { pid: 4242, kill: (signal?: NodeJS.Signals) => { killed.push(signal); return true; } };
			terminateLspChild(child, "SIGTERM", (pid) => { pids.push(pid); });
			assert.deepEqual(pids, [4242]);
			assert.deepEqual(killed, []);

			// Best-effort fallback: taskkill throws, direct kill used.
			terminateLspChild(child, "SIGKILL", () => { throw new Error("taskkill unavailable"); });
			assert.deepEqual(killed, ["SIGKILL"]);

			// POSIX path unchanged: direct kill, no taskkill.
			process.env.PI_WATCHDOG_LSP_PLATFORM_OVERRIDE = "linux";
			const posixKilled: Array<string | undefined> = [];
			const posixPids: number[] = [];
			terminateLspChild({ pid: 4243, kill: (signal?: NodeJS.Signals) => { posixKilled.push(signal); return true; } }, "SIGTERM", (pid) => { posixPids.push(pid); });
			assert.deepEqual(posixKilled, ["SIGTERM"]);
			assert.deepEqual(posixPids, []);
		} finally {
			if (previous === undefined) delete process.env.PI_WATCHDOG_LSP_PLATFORM_OVERRIDE;
			else process.env.PI_WATCHDOG_LSP_PLATFORM_OVERRIDE = previous;
		}
	});
});
