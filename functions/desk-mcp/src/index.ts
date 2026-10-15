// desk-mcp: the MCP server the assistants call (stateless Streamable HTTP: JSON responses to
// POST, no long-lived stream, GET returns 405) and the owner of the Flight, Trip and Metrics
// actor classes.
export { Flight } from "./flight";
export { Trip } from "./trip";
export { Metrics } from "./metrics";
export { CallSession } from "./call";
import { makeLogger } from "../../../shared/log";
import type { CallClaims } from "../../../shared/types";
import type { CallBinding } from "./call";
import { traceFrom } from "../../../shared/util";
import { TOOLS, ToolError } from "./tools";

const SERVER = { name: "nimbus-disruption-desk", version: "1.0.0" };
const rpc = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });

// The fault switch is actor storage, not KV, so a KV outage cannot hide it. The 3 s cache
// keeps the actor read off the tools/call hot path; on timeout or error the previous value
// stands and `at` stays put, so the next call retries.
let faultCache = { at: 0, value: "off" };
async function faultState(env: any): Promise<string> {
  if (Date.now() - faultCache.at < 3_000) return faultCache.value;
  try {
    const value = await Promise.race<string>([
      env.METRICS.idFromName("global").fault(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("fault read timeout")), 300)),
    ]);
    faultCache = { at: Date.now(), value };
  } catch {}
  return faultCache.value;
}

/**
 * Telnyx authenticates with a static bearer (an integration secret only the assistant holds).
 * Which call this is comes from the W3C traceparent Telnyx sends: its trace id is the same one
 * the webhook saw, and the webhook bound the caller to it in a CallSession actor. Tests and the
 * load script use the admin token plus x-trace-id / x-test-booking.
 */
async function authenticate(req: Request, env: any): Promise<CallClaims | null> {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return null;
  if (bearer === process.env.DESK_ADMIN_TOKEN)
    return { trace: req.headers.get("x-trace-id") ?? `test-${Date.now()}`, caller: "", booking: (req.headers.get("x-test-booking") ?? "").toUpperCase() };
  if (bearer !== process.env.DESK_MCP_BEARER) return null;
  // The assistant's MCP client may reopen its session mid-conversation with a fresh per-turn
  // trace id, which has no binding: verification landed on throwaway sessions and a fail counter
  // never accumulated (DEBUGLOG #9, seen again after the 17:01 revision cutover). A
  // Streamable-HTTP session id, echoed by the client on
  // every request, pins the conversation to one trace. The webhook's own link to the
  // conversation's first trace still wins when it is reachable, so a chat caller identified by
  // caller ID is found even if the pin happened before the webhook bound them.
  const sid = req.headers.get("mcp-session-id");
  const tp = traceFrom(req.headers.get("traceparent"), "");
  // One-line diagnostic while the chat identity issue is open: which identity signals arrive,
  // and which branch of the ladder wins (DEBUGLOG #16).
  makeLogger("mcp", env).info("auth", { sid: sid ? "present" : "absent", tp: tp ? "present" : "absent" });
  const pinned = sid ? await probeSession(env, `mcp-session:${sid}`) : null;
  const linked = tp ? await probeSession(env, tp) : null;
  let trace: string;
  if (linked?.canonical) trace = linked.canonical; // 1. the webhook's authoritative link
  else if (pinned?.canonical) trace = pinned.canonical; // 2. the conversation we pinned earlier
  else if (linked && (linked.booking || linked.caller)) trace = tp; // 3. the webhook bound this exact trace
  else if (pinned) trace = `mcp-session-${sid!}`; // 4. pin exists, empty: stable from the first tool call on
  else if (tp) trace = tp; // 5. unlinked: use this turn's trace and pin it from now on
  else trace = `mcp-${Date.now()}`;
  if (sid) env.CALL.idFromName(`mcp-session:${sid}`).link(trace).catch(() => {});
  return { trace, caller: "", booking: "" };
}

/**
 * CallSession reads fail for a few seconds while the actor host restarts on a deploy
 * (DEBUGLOG #14); retry the failure briefly. An empty binding is a real answer, returned as-is.
 */
async function probeSession(env: any, id: string, tries = 3): Promise<CallBinding | null> {
  for (let i = 0; i < tries; i++) {
    const out = await env.CALL.idFromName(id).get().catch(() => null);
    if (out) return out;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health" || url.pathname.startsWith("/health/")) return new Response("ok");
    if (url.pathname !== "/mcp" && url.pathname !== "/") return new Response("not found", { status: 404 });
    // Handing initialize a session id puts Telnyx's client in stateful Streamable-HTTP mode: it
    // sends DELETE to end the session, and a 405 here made it tear down and re-initialize in a
    // loop without ever calling a tool. Acknowledge the teardown.
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    const log = makeLogger("mcp", env);
    const claims = await authenticate(req, env);
    if (!claims) {
      log.info("unauthorized", { path: url.pathname });
      return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
    }
    const msg: any = await req.json().catch(() => null);
    if (!msg || msg.jsonrpc !== "2.0") return rpcError(null, -32700, "parse error");
    if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 }); // notification

    switch (msg.method) {
      case "initialize":
        // No session id here: a stateful client (one that echoes Mcp-Session-Id) turned out to
        // tear its session down every ~10 s and never call a tool, with the model left printing
        // tool calls as text (DEBUGLOG #16). Stateless, traceparent-based identity is what works.
        return rpc(msg.id, { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: SERVER });
      case "ping":
        return rpc(msg.id, {});
      case "tools/list":
        return rpc(msg.id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
      case "tools/call": {
        const name = msg.params?.name as string;
        const tool = TOOLS[name];
        if (!tool) return rpcError(msg.id, -32602, `unknown tool ${name}`);
        const t0 = Date.now();
        try {
          // The console's fault switch makes the desk unhealthy on purpose: every tool throws into
          // the backend_error path below (span outcome "error", the model is told to apologise and
          // offer a callback or a person). request_callback is exempt so the degraded path still
          // has a way out.
          if ((await faultState(env)) === "mcp_down" && name !== "request_callback") throw new Error("fault injected: mcp_down");
          const out = await tool.run({ env, claims, log }, msg.params?.arguments ?? {});
          const outcome = (out as any).held === false || (out as any).confirmed === false || (out as any).verified === false ? "declined" : "ok";
          // Booking codes and last names are the two factors verify_booking asks for: they are
          // never written to trace spans.
          const args: Record<string, unknown> = msg.params?.arguments ?? {};
          const detail = JSON.stringify(Object.fromEntries(Object.entries(args).map(([k, v]) => [k, /code|last_name/i.test(k) ? "redacted" : v]))).slice(0, 120);
          log.span({ trace: claims.trace, op: `tool:${name}`, outcome, ms: Date.now() - t0, detail });
          env.METRICS.idFromName("global").callUpdated(claims.trace, name, outcomeFor(name, out)).catch(() => {});
          return rpc(msg.id, { content: [{ type: "text", text: JSON.stringify(out) }] });
        } catch (e: any) {
          const expected = e instanceof ToolError;
          log.span({ trace: claims.trace, op: `tool:${name}`, outcome: expected ? e.code : "error", ms: Date.now() - t0, detail: String(e?.message ?? e).slice(0, 200) });
          // Tool errors go back to the model as results it can recover from, not protocol errors.
          return rpc(msg.id, {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ error: expected ? e.code : "backend_error", message: expected ? e.message : "The booking system is not responding. Apologise and offer a callback or a person." }) }],
          });
        }
      }
      default:
        return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
    }
  },
};

function outcomeFor(tool: string, out: any): string | undefined {
  if (tool === "confirm_rebooking" && out.confirmed) return "rebooked";
  if (tool === "request_refund" && out.refunded) return "refunded";
  if (tool === "cancel_booking" && out.cancelled) return "cancelled";
  if (tool === "join_waitlist" && out.waitlisted) return "waitlisted";
  if (tool === "request_callback" && out.booked) return "callback_booked";
  return undefined;
}
