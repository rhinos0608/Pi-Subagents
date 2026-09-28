import * as fs from "node:fs";
import * as path from "node:path";

export function writeAsyncStatusFixture(asyncRoot: string, runId: string, state: string, extra: object = {}): void {
	const dir = path.join(asyncRoot, runId);
	fs.mkdirSync(dir, { recursive: true });
	const now = Date.now();
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
		runId,
		mode: "single",
		state,
		startedAt: now,
		lastUpdate: now,
		steps: [{ agent: "worker", status: state }],
		...extra,
	}), "utf-8");
}
