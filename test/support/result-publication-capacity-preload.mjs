// Child-runner-only fault injection. Barriers are filesystem events, not elapsed waits.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const root = process.env.RESULT_PUBLICATION_TEST_ROOT;
if (root) {
	const write = fs.writeFileSync;
	const open = fs.openSync;
	const rename = fs.renameSync;
	let resultAttempts = 0;
	let runningWritten = false;
	let statusDeferred = false;
	let asyncDir;
	let failedRecovery = false;
	const earlyTerminal = fs.existsSync(path.join(root, "early-terminal"));
	const barrier = (name, data) => {
		write(path.join(root, `${name}.tmp`), JSON.stringify(data));
		rename(path.join(root, `${name}.tmp`), path.join(root, name));
	};
	const full = () => Object.assign(new Error("injected result publication capacity failure"), { code: "ENOSPC" });
	const inspectedStatusTemps = new Set();
	const inspectStatusTemp = (target, data) => {
		if (!path.basename(target).startsWith(".status.json.")) return;
		const status = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
		asyncDir = path.dirname(target);
		if (!earlyTerminal && runningWritten && resultAttempts === 0) {
			statusDeferred = true;
			throw full();
		}
		if (status.state === "running") runningWritten = true;
	};
	const interceptPendingResultWrite = (target) => {
		if (!target.includes(`${path.sep}result-pending${path.sep}`) || !target.endsWith(".tmp")) return;
		resultAttempts++;
		if (!fs.existsSync(path.join(root, "release"))) {
			if (resultAttempts >= 2) {
				const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
				barrier("blocked.json", {
					state: status.state, statusDeferred,
					active: fs.existsSync(path.join(path.dirname(asyncDir), ".active-runs", path.basename(asyncDir))),
				});
			}
			throw full();
		}
		if (!failedRecovery && fs.existsSync(path.join(root, "fail-on-recovery"))) {
			failedRecovery = true;
			throw Object.assign(new Error("injected non-capacity publication failure"), { code: "EIO" });
		}
	};
	fs.writeFileSync = function (file, data, ...args) {
		const target = String(file);
		inspectStatusTemp(target, data);
		if (path.basename(target).startsWith(".status.json.")) inspectedStatusTemps.add(target);
		interceptPendingResultWrite(target);
		return write.call(this, file, data, ...args);
	};
	fs.openSync = function (file, flags, mode) {
		interceptPendingResultWrite(String(file));
		return open.call(this, file, flags, mode);
	};
	fs.renameSync = function (source, target) {
		const sourcePath = String(source);
		const targetPath = String(target);
		if (path.basename(targetPath) === "status.json" && path.basename(sourcePath).startsWith(".status.json.")) {
			if (!inspectedStatusTemps.delete(sourcePath)) inspectStatusTemp(sourcePath, fs.readFileSync(sourcePath));
		}
		const result = rename.call(this, source, target);
		if (!earlyTerminal && path.basename(targetPath) === "steer-inbox-closed.json") {
			// A request queued just before inbox closure is consumed during finalization.
			const dir = path.join(path.dirname(String(target)), "steer-requests");
			fs.mkdirSync(dir, { recursive: true });
			write(path.join(dir, "publication-steer.json"), JSON.stringify({ type: "steer", id: "publication-steer", ts: 1, message: "Late queued request", targetIndex: 0 }));
		}
		if (path.basename(String(target)) === "status.json") {
			const status = JSON.parse(fs.readFileSync(target, "utf8"));
			if (status.state === "complete" || status.state === "failed") barrier("terminal.json", status);
		}
		if (earlyTerminal && path.basename(String(target)) === "process-terminal-candidate.json") {
			const candidate = JSON.parse(fs.readFileSync(target, "utf8"));
			if (candidate.expectedWriters) barrier("drained.json", candidate);
		}
		return result;
	};
	syncBuiltinESMExports();
}
