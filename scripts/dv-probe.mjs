#!/usr/bin/env node
// Local stand-in for the dynamic-variables webhook, for testing Telnyx's webhook contract in
// seconds instead of a 6-15 minute ship. Logs what Telnyx sends; replies with probe-reply.json
// (re-read per request). Run: node scripts/dv-probe.mjs, then expose it with ngrok http 8787.
import { createServer } from "node:http";
import { readFileSync, appendFileSync } from "node:fs";

const LOG = ".tools/dv-probe.log";
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const delay = Number(process.env.PROBE_DELAY_MS ?? 0);
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, headers: req.headers, body }) + "\n");
    setTimeout(() => {
      const reply = readFileSync(".tools/probe-reply.json", "utf8");
      res.writeHead(200, { "content-type": "application/json" }).end(reply);
    }, delay);
  });
}).listen(8787, () => console.log("dv probe on :8787"));
