import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@mariozechner/pi-tui";
import { wrapText } from "../../src/tui/text-editor.ts";

test("wrapText keeps wide characters within the display width", () => {
	const wrapped = wrapText("First maybe use 织 to new maybe replace entire file", 20);

	assert.deepEqual(wrapped.lines, ["First maybe use 织 t", "o new maybe replace ", "entire file"]);
	for (const line of wrapped.lines) {
		assert.ok(visibleWidth(line) <= 20, `${line} is wider than 20 columns`);
	}
});
