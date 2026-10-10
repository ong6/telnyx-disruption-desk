// desk-mcp: the MCP server the assistants call (stateless Streamable HTTP: JSON responses to
// POST, no long-lived stream, GET returns 405) and the owner of the Flight, Trip and Metrics
// actor classes.
export { Flight } from "./flight";
export { Trip } from "./trip";
export { Metrics } from "./metrics";
export { CallSession } from "./call";
import { makeLogger } from "../../../shared/log";
import type { CallClaims } from "../../../shared/types";
import { traceFrom } from "../../../shared/util";
import { TOOLS, ToolError } from "./tools";

const SERVER = { name: "nimbus-disruption-desk", version: "1.0.0" };
const rpc = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * Telnyx authenticates with a static bearer (an integration secret only the assistant holds).
 * Which call this is comes from the W3C traceparent Telnyx sends: its trace id is the same one
 * the webhook saw, and the webhook bound the caller to it in a CallSession actor. Tests and the
 * load script use the admin token plus x-trace-id / x-test-booking.
 */
function authenticate(req: Request): CallClaims | null {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return null;
  if (bearer === process.env.DESK_ADMIN_TOKEN)
    return { trace: req.headers.get("x-trace-id") ?? `test-${Date.now()}`, caller: "", booking: (req.headers.get("x-test-booking") ?? "").toUpperCase() };
  if (bearer !== process.env.DESK_MCP_BEARER) return null;
  return { trace: traceFrom(req.headers.get("traceparent"), "mcp-" + Date.now()), caller: "", booking: "" };
}

export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health" || url.pathname.startsWith("/health/")) return new Response("ok");
    if (url.pathname !== "/mcp" && url.pathname !== "/") return new Response("not found", { status: 404 });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    const log = makeLogger("mcp", env);
    const claims = authenticate(req);
    if (!claims) {
      log.info("unauthorized", { path: url.pathname });
      return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
    }
    const msg: any = await req.json().catch(() => null);
    if (!msg || msg.jsonrpc !== "2.0") return rpcError(null, -32700, "parse error");
    if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 }); // notification

    switch (msg.method) {
      case "initialize":
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
          const out = await tool.run({ env, claims, log }, msg.params?.arguments ?? {});
          const outcome = (out as any).held === false || (out as any).confirmed === false || (out as any).verified === false ? "declined" : "ok";
          log.span({ trace: claims.trace, op: `tool:${name}`, outcome, ms: Date.now() - t0, detail: JSON.stringify(msg.params?.arguments ?? {}).slice(0, 120) });
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
  if (tool === "join_waitlist" && out.waitlisted) return "waitlisted";
  if (tool === "request_callback" && out.booked) return "callback_booked";
  return undefined;
}
