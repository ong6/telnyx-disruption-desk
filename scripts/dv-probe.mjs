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
    if (req.url.startsWith("/mcp")) {
      // Minimal MCP responder, to see what Telnyx's MCP client sends.
      const msg = body ? JSON.parse(body) : {};
      if (msg.id === undefined) return res.writeHead(202).end();
      const result =
        msg.method === "initialize" ? { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "0" } }
        : msg.method === "tools/list" ? { tools: [{ name: "get_trip_status", description: "The caller's booking status.", inputSchema: { type: "object", properties: {} } }] }
        : msg.method === "tools/call" ? { content: [{ type: "text", text: JSON.stringify({ booking_code: "K7Q2ZX", status: "cancelled", note: "probe" }) }] }
        : {};
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    }
    setTimeout(() => {
      const reply = readFileSync(".tools/probe-reply.json", "utf8");
      res.writeHead(200, { "content-type": "application/json" }).end(reply);
    }, delay);
  });
}).listen(8787, () => console.log("dv probe on :8787"));
