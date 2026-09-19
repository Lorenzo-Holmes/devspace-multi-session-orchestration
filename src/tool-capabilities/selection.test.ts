import assert from "node:assert/strict";
import test from "node:test";
import { SELECTION_SCENARIOS } from "./scenarios.js";
import { recommendTools } from "./recommend.js";
test("curated scenarios have independent IDs and more than 100 cases", () => {
  assert.ok(SELECTION_SCENARIOS.length >= 100);
  assert.equal(new Set(SELECTION_SCENARIOS.map(s => s.id)).size, SELECTION_SCENARIOS.length);
});
for (const scenario of SELECTION_SCENARIOS) test(`selection ${scenario.id}: ${scenario.request}`, () => {
  const input = JSON.stringify(scenario.context);
  const result = recommendTools(scenario.context);
  assert.deepEqual(result.recommended.map(t => t.toolName), scenario.expected);
  assert.equal(result.authorization, false); assert.equal(result.advisoryOnly, true);
  assert.deepEqual(result, recommendTools(scenario.context));
  assert.equal(JSON.stringify(scenario.context), input);
});
