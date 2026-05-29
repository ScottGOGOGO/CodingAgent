import test from "node:test";
import assert from "node:assert/strict";

import { commandForStep } from "./runner.js";

test("commandForStep maps install and build commands", () => {
  assert.deepEqual(commandForStep("install"), ["npm", "install"]);
  assert.deepEqual(commandForStep("build"), ["npm", "run", "build"]);
});

test("commandForStep injects preview port", () => {
  assert.deepEqual(commandForStep("preview", 4300), [
    "npm",
    "run",
    "start",
    "--",
    "--hostname",
    "0.0.0.0",
    "--port",
    "4300",
  ]);
});
