import test from "node:test";
import assert from "node:assert/strict";

import type { ExecutionStep } from "@vide/contracts";

import { commandForStep } from "./runner.js";

test("commandForStep maps install and build steps", () => {
  const installStep: ExecutionStep = {
    type: "install_dependencies",
    description: "Install deps",
    packageManager: "npm",
  };
  const buildStep: ExecutionStep = {
    type: "build_web_app",
    description: "Build app",
    packageManager: "npm",
  };

  assert.deepEqual(commandForStep(installStep), ["npm", "install"]);
  assert.deepEqual(commandForStep(buildStep), ["npm", "run", "build"]);
});

test("commandForStep injects preview port", () => {
  const step: ExecutionStep = {
    type: "start_vite_preview",
    description: "Start preview",
    packageManager: "npm",
    port: 4173,
  };

  assert.deepEqual(commandForStep(step, 4300), [
    "npm",
    "run",
    "dev",
    "--",
    "--host",
    "0.0.0.0",
    "--port",
    "4300",
  ]);
});
