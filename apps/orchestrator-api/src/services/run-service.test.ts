import test from "node:test";
import assert from "node:assert/strict";

import { CommandExecutionError } from "../runner.js";
import { summarizeRunFailure } from "./run-service.js";

test("summarizeRunFailure includes useful build output context", () => {
  const error = new CommandExecutionError(
    ["npm", "run", "build"],
    [
      "> demo@0.0.0 build",
      "> vite build",
      "error during build:",
      "Unexpected end of JSON input while parsing near '\"references\": [{\"path'",
      "failed to load /tmp/demo/tsconfig.json",
    ].join("\n"),
  );

  const message = summarizeRunFailure(error);

  assert.match(message, /npm run build 失败/);
  assert.match(message, /Unexpected end of JSON input/);
  assert.match(message, /tsconfig\.json/);
});

test("summarizeRunFailure falls back to the error message for non-command failures", () => {
  assert.equal(summarizeRunFailure(new Error("index.html 看起来不完整或已被截断。")), "index.html 看起来不完整或已被截断。");
});
