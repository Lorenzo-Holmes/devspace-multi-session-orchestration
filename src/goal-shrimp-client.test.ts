import test from "node:test";
import assert from "node:assert/strict";
import { validateTasks, nextShrimpTask } from "./goal-shrimp-client.js";
const ids = ["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"];
const tasks = () => ids.map((id,i) => ({ id, name: `Task ${i}`, description: "A sufficiently detailed task", createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", status: "pending", dependencies: i ? [{taskId:ids[i-1]}] : [] }));
test("select A then B; completed A never selected again", () => {
  const state = validateTasks({ tasks: tasks() });
  assert.equal(nextShrimpTask(state)?.id, ids[0]);
  state[0].status = "completed";
  assert.equal(nextShrimpTask(state)?.id, ids[1]);
  state[1].status = "in_progress";
  assert.equal(nextShrimpTask(state)?.id, ids[1]);
  state.forEach(t => {t.status = "completed";});
  assert.equal(nextShrimpTask(state), null);
});
test("reject missing/cyclic/duplicate task references", () => {
  const missing = tasks(); missing[0].dependencies = [{taskId:"44444444-4444-4444-8444-444444444444"}];
  assert.throws(() => validateTasks({tasks:missing}), /DEPENDENCY_INVALID/);
  const cycle = tasks(); cycle[0].dependencies = [{taskId:ids[2]}];
  assert.throws(() => validateTasks({tasks:cycle}), /cycle/);
  assert.throws(() => validateTasks({tasks:[...tasks(), tasks()[0]]}), /duplicate/);
});
test("ambiguous running state and unsafe Git metadata fail closed", () => {
  const state = validateTasks({tasks:tasks()});
  state[0].status = "in_progress"; state[1].status = "in_progress";
  assert.throws(() => nextShrimpTask(state), /multiple/);
  const unsafe = tasks(); unsafe[0].name = 'quote" & command';
  assert.throws(() => validateTasks({tasks:unsafe}));
});
