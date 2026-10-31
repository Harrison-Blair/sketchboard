import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PORT, ENDPOINTS, IDLE_TIMEOUT_MS, emptyIndex } from "../src/protocol.js";

test("protocol constants match the plan", () => {
  assert.equal(DEFAULT_PORT, 4870);
  assert.equal(IDLE_TIMEOUT_MS, 1_800_000);
});

test("every API endpoint is under the tool prefix", () => {
  for (const [name, e] of Object.entries(ENDPOINTS)) {
    if (["home", "shell", "file"].includes(name)) continue;
    assert.ok(e.path.startsWith("/__sketchboard/"), name);
  }
});

test("empty index is a v1 canvas with no boards", () => {
  assert.deepEqual(emptyIndex("Demo"), { v: 1, title: "Demo", boards: {}, order: [], notes: {}, compare: {} });
});
