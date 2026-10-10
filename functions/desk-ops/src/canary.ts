// A synthetic caller that runs every minute from an actor alarm: it calls the webhook and the
// MCP server the way Telnyx does and records whether each answered, and how fast. The console
// turns red when the last good probe is older than 90 seconds: that is the "know within a
// minute" signal, and it keeps the functions warm as a side effect.
import { StatefulActor } from "@telnyx/edge-runtime";
import { URLS } from "../../../shared/endpoints";

const EVERY_MS = 60_000;
type Probe = { ok: boolean; ms: number; status: number; detail?: string };
export type CanaryRun = { at: number; dv: Probe; mcpList: Probe; mcpTool: Probe };

async function probe(url: string, init: RequestInit, check: (body: any) => boolean): Promise<Probe> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const body = await res.json().catch(() => null);
    const ok = res.ok && check(body);
    return { ok, ms: Date.now() - t0, status: res.status, detail: ok ? undefined : JSON.stringify(body).slice(0, 160) };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, status: 0, detail: String(e?.message ?? e).slice(0, 160) };
  }
}

export class Canary extends StatefulActor {
  async start() {
    await this.ctx.storage.put("running", true);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return { running: true };
  }
  async stop() {
    await this.ctx.storage.put("running", false);
    await this.ctx.storage.deleteAlarm();
    return { running: false };
  }
  async runs(): Promise<{ running: boolean; runs: CanaryRun[] }> {
    return { running: !!(await this.ctx.storage.get("running")), runs: (await this.ctx.storage.get<CanaryRun[]>("runs")) ?? [] };
  }

  async alarm(): Promise<void> {
    if (!(await this.ctx.storage.get("running"))) return;
    const trace = `canary-${Date.now()}`;
    const token = await (this.env as any).SECRETS.get("ADMIN_TOKEN");
    const admin = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-trace-id": trace };
    const rpc = (method: string, params: object = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const [dv, mcpList, mcpTool] = await Promise.all([
      probe(`${URLS.dv}/`, { method: "POST", headers: { "content-type": "application/json", "x-canary": "1" }, body: JSON.stringify({ data: { event_type: "assistant.initialization", payload: { telnyx_conversation_channel: "canary", call_control_id: trace } } }) },
        (b) => !!b?.dynamic_variables?.trace_id),
      probe(`${URLS.mcp}/mcp`, { method: "POST", headers: admin, body: rpc("tools/list") }, (b) => (b?.result?.tools?.length ?? 0) >= 3),
      probe(`${URLS.mcp}/mcp`, { method: "POST", headers: { ...admin, "x-test-booking": "H8N6CU" }, body: rpc("tools/call", { name: "get_trip_status", arguments: {} }) },
        (b) => b?.result && !b.result.isError),
    ]);
    const run: CanaryRun = { at: Date.now(), dv, mcpList, mcpTool };
    const runs = [run, ...((await this.ctx.storage.get<CanaryRun[]>("runs")) ?? [])].slice(0, 30);
    await this.ctx.storage.put("runs", runs);
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "canary", ev: "probe", ok: dv.ok && mcpList.ok && mcpTool.ok, dv: dv.ms, mcpList: mcpList.ms, mcpTool: mcpTool.ms, detail: [dv, mcpList, mcpTool].find((p) => !p.ok)?.detail }));
    await this.ctx.storage.setAlarm(Date.now() + EVERY_MS);
  }
}
