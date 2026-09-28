import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import { ensureTempRootDir, TEMP_ROOT_DIR } from "../../src/shared/types.ts";

describe("private directory mode portability", () => {
	after(() => {
		if (process.platform !== "win32" && fs.existsSync(TEMP_ROOT_DIR)) fs.chmodSync(TEMP_ROOT_DIR, 0o700);
	});

	it("does not interpret synthetic POSIX mode bits as a Windows ACL contract", () => {
		if (process.platform === "win32") return;
		ensureTempRootDir();
		fs.chmodSync(TEMP_ROOT_DIR, 0o755);
		assert.doesNotThrow(() => ensureTempRootDir("win32"));
		assert.equal(fs.lstatSync(TEMP_ROOT_DIR).mode & 0o777, 0o755);
	});

	it("still normalizes non-private mode bits on POSIX", () => {
		if (process.platform === "win32") return;
		fs.chmodSync(TEMP_ROOT_DIR, 0o755);
		ensureTempRootDir("linux");
		assert.equal(fs.lstatSync(TEMP_ROOT_DIR).mode & 0o777, 0o700);
	});
});
