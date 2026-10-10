import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSOLE_HTML } from "../functions/desk-ops/src/console.ts";

// The console's script lives in a template literal, where one wrong escape breaks the whole page
// (it shipped once: an unescaped apostrophe left the board empty).
test("console page script parses", () => {
  const script = CONSOLE_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  assert.ok(script.length > 1000);
  assert.doesNotThrow(() => new Function(script));
});
