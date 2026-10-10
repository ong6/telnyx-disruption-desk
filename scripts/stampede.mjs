#!/usr/bin/env node
// 300 callers try to grab 60 seats at the same moment, twice: once through the Flight actor and
// once through a naive KV read-modify-write. The actor must hand out exactly 60; KV oversells.
// Usage: source scripts/env.sh && node scripts/stampede.mjs [callers] [seats]
import { writeFileSync } from "node:fs";

const OPS = "https://desk-ops-68bad318-0.telnyxcompute.com";
const callers = Number(process.argv[2] ?? 300);
const seats = Number(process.argv[3] ?? 60);
const auth = { authorization: `Bearer ${process.env.DESK_ADMIN_TOKEN}`, "content-type": "application/json" };
const post = (path, body) => fetch(`${OPS}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) }).then((r) => r.json());

async function run(mode) {
  await post("/lab/reset", { capacity: seats });
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: callers }, (_, i) => post(`/lab/hold?mode=${mode}`, { who: `P${i}` }).catch((e) => ({ ok: false, error: String(e) }))),
  );
  const ms = Date.now() - t0;
  const granted = results.filter((r) => r.ok).length;
  const errors = results.filter((r) => r.error).length;
  const state = await (await fetch(`${OPS}/lab/result`, { headers: auth })).json();
  const recorded = mode === "kv" ? state.kv.held : state.actor.held;
  return { mode, callers, seats, granted, recorded, oversold: Math.max(0, granted - seats), errors, ms };
}

const rows = [await run("actor"), await run("kv")];
const lines = [
  `stampede ${new Date().toISOString()}: ${callers} concurrent callers, ${seats} seats`,
  "mode   granted  store says  oversold  errors  wall ms",
  ...rows.map((r) => `${r.mode.padEnd(6)} ${String(r.granted).padStart(7)}  ${String(r.recorded).padStart(10)}  ${String(r.oversold).padStart(8)}  ${String(r.errors).padStart(6)}  ${String(r.ms).padStart(7)}`),
];
console.log(lines.join("\n"));
const file = `docs/evidence/stampede-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
writeFileSync(file, lines.join("\n") + "\n");
console.log(`saved ${file}`);
