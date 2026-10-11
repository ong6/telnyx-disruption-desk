// desk-ops: the operations console (live seats, calls, traces, health) and the controls an
// airline ops team would have during a disruption: load a scenario, flip flags without a
// redeploy, add a relief flight. Also the lab routes for the stampede test.
export { Canary } from "./canary";
export { Surge } from "./surge";
import { readConfig, resetConfigCache, writeFlags, type Flags, type Scenario } from "../../../shared/config";
import { URLS } from "../../../shared/endpoints";
import { makeLogger } from "../../../shared/log";
import { BOOKINGS, INCIDENTS, RELIEF_FLIGHT } from "../../../shared/seed";
import type { FlightSnapshot } from "../../../shared/types";
import { addDays, flightId, maskPhone, sgDate } from "../../../shared/util";
import { CONSOLE_HTML } from "./console";

const ROUTES = [["SIN", "HKG"], ["SIN", "NRT"]];
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: { "cache-control": "no-store" } });

const pssFetch = (path: string, init: RequestInit = {}) =>
  fetch(`${URLS.pss}${path}`, { ...init, signal: AbortSignal.timeout(5_000), headers: { authorization: `Bearer ${process.env.PSS_API_KEY}`, "content-type": "application/json" } }).then(async (r) => {
    if (!r.ok) throw new Error(`pss ${r.status} ${path}: ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<any>;
  });

function isAdmin(req: Request, url: URL) {
  const t = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") || url.searchParams.get("key") || "";
  return !!t && t === process.env.DESK_ADMIN_TOKEN;
}

export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const log = makeLogger("ops", env);
    if (path === "/health" || path.startsWith("/health/")) return new Response("ok");
    if (path === "/" && req.method === "GET") return new Response(CONSOLE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });

    try {
      // Anonymous viewers get the operational picture (flags, flights, canary) but not passenger
      // data: trips, call traces and the callback queue carry booking codes, names and references.
      if (path === "/api/state" && !isAdmin(req, url)) {
        const s: any = await state(env);
        return json({ now: s.now, stateBuildMs: s.stateBuildMs, degraded: s.degraded, flags: s.flags, scenario: s.scenario, flights: s.flights, canary: s.canary, surge: s.surge ? { running: s.surge.running } : null, metrics: { latency: s.metrics?.latency } });
      }
      if (path === "/api/state") return json(await state(env));
      // Read by the workflow's handoff gate (a tool node): 200 = a person can take the call.
      if (path === "/api/queue") {
        const { flags } = await readConfig(env);
        return json({ queue: flags.human_queue }, flags.human_queue === "full" ? 409 : 200);
      }
      if (path.startsWith("/api/trace/")) {
        if (!isAdmin(req, url)) return json({ error: "admin token required" }, 401);
        return json(await trace(env, path.split("/")[3]));
      }

      if (!isAdmin(req, url)) return json({ error: "admin token required" }, 401);
      const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      if (path === "/api/scenario" && req.method === "POST") return json(await loadScenario(env, body.id ?? "normal", log));
      if (path === "/api/flags" && req.method === "POST") {
        const allowed: (keyof Flags)[] = ["disruption_mode", "human_queue", "hold_ttl_secs", "web_calls_as_demo_caller"];
        const patch = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k as keyof Flags)));
        const flags = await writeFlags(env, patch);
        log.info("flags", { patch });
        if ("disruption_mode" in patch || "human_queue" in patch) await syncAssistantDefaults(env, log);
        return json(flags);
      }
      if (path === "/api/relief" && req.method === "POST") {
        const { scenario } = await readConfig(env);
        const base = scenario?.baseDate ?? sgDate(0);
        const f = await pssFetch("/v1/admin/flights", { method: "POST", body: JSON.stringify({ baseDate: base }) });
        const snap = await env.FLIGHT.idFromName(flightId(f.number, f.date)).init({ id: flightId(f.number, f.date), number: f.number, date: f.date, dep: f.dep, arr: f.arr, from: f.origin, to: f.dest, status: f.status, capacity: f.capacity, sold: f.sold });
        log.info("relief_flight", { flight: snap.id });
        return json(snap);
      }
      // Simulates another passenger giving up seats (a refund elsewhere): the Flight actor's alarm
      // then offers them to the waitlist and the Trip actor calls the first person back.
      if (path === "/api/release" && req.method === "POST") {
        const r = await env.FLIGHT.idFromName(String(body.flightId)).returnSeats("SIM-RELEASE", Number(body.seats ?? 1));
        log.info("release", { flight: body.flightId, seats: body.seats ?? 1 });
        return json(r);
      }
      if (path === "/api/surge" && req.method === "POST") {
        const { scenario } = await readConfig(env);
        if (scenario?.id !== "typhoon") return json({ error: "load the typhoon scenario first" }, 409);
        const callers = Math.min(Number(body.callers ?? 200), 500);
        const sim = await pssFetch("/v1/admin/synthetic", { method: "POST", body: JSON.stringify({ count: callers, baseDate: scenario.baseDate }) });
        const flightOf = (i: number) => sim.flights[(i + 1) % sim.flights.length].split("-");
        await Promise.all(sim.codes.map((c: { code: string; pax: number }, i: number) =>
          env.TRIP.idFromName(c.code).init({ code: c.code, firstName: "Sim", lastName: `Passenger${i + 1}`, phone: "", pax: c.pax, flight: flightOf(i)[0], day: 0, tier: "none" }, scenario.baseDate)));
        const started = await env.SURGE.idFromName("main").start(sim.codes.map((c: { code: string }) => c.code), Number(body.seconds ?? 30), flightId("NB862", addDays(scenario.baseDate, 1)));
        log.info("surge", { callers, seconds: body.seconds ?? 30 });
        return json({ total: started.total, perWave: started.perWave });
      }
      if (path === "/api/canary" && req.method === "POST") return json(await env.CANARY.idFromName("main")[body.run === false ? "stop" : "start"]());
      if (path === "/api/metrics/reset" && req.method === "POST") return json(await env.METRICS.idFromName("global").reset());

      // Lab: the same seat-hold race through an actor and through naive KV read-modify-write.
      if (path === "/lab/reset" && req.method === "POST") {
        const capacity = Number(body.capacity ?? 60);
        await env.FLIGHT.idFromName("LAB-ACTOR").init({ id: "LAB-ACTOR", number: "LAB", date: "lab", dep: "00:00", arr: "00:00", from: "LAB", to: "LAB", status: "scheduled", capacity, sold: 0 });
        await env.KV.put("lab/kv-held", "0");
        await env.KV.put("lab/kv-capacity", String(capacity));
        return json({ capacity });
      }
      if (path === "/lab/hold" && req.method === "POST") {
        const who = String(body.who ?? Math.random());
        if (url.searchParams.get("mode") === "kv") {
          const [held, cap] = await Promise.all([env.KV.get("lab/kv-held"), env.KV.get("lab/kv-capacity")]);
          if (Number(held) >= Number(cap)) return json({ ok: false });
          await new Promise((r) => setTimeout(r, 30)); // the work between read and write: a fare check
          await env.KV.put("lab/kv-held", String(Number(held) + 1));
          return json({ ok: true });
        }
        const r = await env.FLIGHT.idFromName("LAB-ACTOR").hold(who, 1, 600);
        return json({ ok: r.ok });
      }
      if (path === "/lab/result") {
        const snap: FlightSnapshot = await env.FLIGHT.idFromName("LAB-ACTOR").snapshot();
        return json({ actor: { capacity: snap?.capacity, held: snap?.held }, kv: { capacity: Number(await env.KV.get("lab/kv-capacity")), held: Number(await env.KV.get("lab/kv-held")) } });
      }
      return json({ error: "not found" }, 404);
    } catch (e: any) {
      log.error("ops", { path, err: String(e?.message ?? e) });
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },
};

/** Rebuild the reservation system, flight actors and trip actors for a scenario. */
/**
 * Flags live in KV, but a cold webhook can't wait for a KV read (over a second) inside Telnyx's
 * ~1.2 s window. So every flag change is also written into both assistants' default dynamic
 * variables: a call routes on the right flags even if the webhook answers late or leaves them out.
 */
async function syncAssistantDefaults(env: any, log: ReturnType<typeof makeLogger>) {
  const { flags, scenario } = await readConfig(env, true);
  const ids: string[] = JSON.parse((await env.KV.get("config/assistants")) ?? "[]");
  const patch = { disruption_mode: flags.disruption_mode, human_queue: flags.human_queue, incident_notice: flags.disruption_mode === "on" ? scenario?.notice ?? "" : "" };
  const headers = { authorization: `Bearer ${process.env.DESK_TELNYX_KEY}`, "content-type": "application/json" };
  await Promise.all(ids.map(async (id) => {
    const curRes = await fetch(`https://api.telnyx.com/v2/ai/assistants/${id}`, { headers });
    if (!curRes.ok) {
      // Never PATCH on a failed read: the response body would have no dynamic_variables and the
      // spread would replace every assistant default with just the flags, destroying the
      // documented cold-webhook fallback precisely while the API is unhealthy.
      log.error("assistant_defaults", { id, stage: "read", status: curRes.status });
      return;
    }
    const cur = (await curRes.json()) as any;
    const res = await fetch(`https://api.telnyx.com/v2/ai/assistants/${id}`, { method: "POST", headers, body: JSON.stringify({ dynamic_variables: { ...(cur.dynamic_variables ?? cur.data?.dynamic_variables ?? {}), ...patch } }) });
    (res.ok ? log.info : log.error)("assistant_defaults", { id, status: res.status, ...patch, incident_notice: patch.incident_notice ? "set" : "" });
  }));
  return patch;
}

async function loadScenario(env: any, id: string, log: ReturnType<typeof makeLogger>) {
  const baseDate = sgDate(0);
  const incident = INCIDENTS[id];
  const reset = await pssFetch("/v1/admin/reset", { method: "POST", body: JSON.stringify({ scenario: incident ? id : undefined, baseDate }) });
  const flights: any[] = (await Promise.all(ROUTES.map(([o, d]) => pssFetch(`/v1/flights?origin=${o}&dest=${d}&from=${baseDate}&to=${addDays(baseDate, 2)}`)))).flat();
  await Promise.all(
    flights.map((f) =>
      env.FLIGHT.idFromName(flightId(f.number, f.date)).init({ id: flightId(f.number, f.date), number: f.number, date: f.date, dep: f.dep, arr: f.arr, from: f.origin, to: f.dest, status: f.status, capacity: f.capacity, sold: f.sold }),
    ),
  );
  await Promise.all(
    BOOKINGS.map((b) => env.TRIP.idFromName(b.code).init({ ...b, phone: b.phone === "$DEMO_CALLER" ? process.env.DEMO_CALLER_NUMBER ?? "" : b.phone }, addDays(baseDate, b.day))),
  );
  const scenario: Scenario = { id, baseDate, notice: incident?.notice ?? "", cancelled: reset.cancelled ?? [], loadedAt: Date.now() };
  await env.KV.put("scenario/active", JSON.stringify(scenario));
  await writeFlags(env, { disruption_mode: incident ? "on" : "off" });
  resetConfigCache();
  await syncAssistantDefaults(env, log);
  log.info("scenario", { id, baseDate, flights: flights.length, cancelled: scenario.cancelled });
  return { scenario, flights: flights.length, bookings: BOOKINGS.length };
}

async function state(env: any) {
  const { flags, scenario } = await readConfig(env);
  const base = scenario?.baseDate ?? sgDate(0);
  const ids = [...new Set([
    ...["NB862", "NB866", "NB868"].flatMap((n) => [0, 1, 2].map((d) => flightId(n, addDays(base, d)))),
    flightId(RELIEF_FLIGHT.number, addDays(base, RELIEF_FLIGHT.day)),
  ])];
  const t0 = Date.now();
  const degrade = (name: string, p: Promise<unknown>) => p.catch(() => (degraded.push(name), null));
  const degraded: string[] = [];
  const [flights, metrics, canary, surge] = await Promise.all([
    degrade("flights", Promise.all(ids.map((id) => env.FLIGHT.idFromName(id).snapshot()))),
    degrade("metrics", env.METRICS.idFromName("global").summary(15)),
    degrade("canary", env.CANARY.idFromName("main").runs()),
    degrade("surge", env.SURGE.idFromName("main").state()),
  ]);
  const trips = await Promise.all(BOOKINGS.map((b) => degrade("trips", env.TRIP.idFromName(b.code).get())));
  const callbacks = (((metrics as any)?.callbacks ?? []) as any[]).map((c) => ({ ...c, caller: maskPhone(c.caller) }));
  return {
    now: Date.now(),
    // An operator should see at a glance when the console itself is reading a broken subsystem
    // instead of silently showing blanks (a dead actor host showed up as 6-second polls first).
    degraded: degraded.length ? degraded : undefined,
    stateBuildMs: Date.now() - t0,
    flags,
    scenario,
    flights: ((flights as any[]) ?? []).filter(Boolean).sort((a: any, b: any) => (a.date + a.dep).localeCompare(b.date + b.dep)),
    trips: ((trips as any[]) ?? []).filter(Boolean).map((t: any) => ({
      code: t.booking.code, name: `${t.booking.firstName} ${t.booking.lastName}`, pax: t.booking.pax, phone: maskPhone(t.booking.phone),
      status: t.status, hold: t.hold, rebookedTo: t.rebookedTo, refund: t.refund, waitlist: t.waitlist, callback: t.callback, calls: t.calls, events: t.events.slice(-4),
    })),
    callbacks,
    metrics,
    canary,
    surge,
  };
}

async function trace(env: any, id: string) {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return { error: "bad id" };
  const { keys } = await env.KV.list({ prefix: `trace/${id}/`, limit: 200 });
  const spans = (await Promise.all(keys.map((k: { name: string }) => env.KV.get(k.name)))).filter(Boolean).map((s: string) => JSON.parse(s));
  return { trace: id, spans: spans.sort((a: any, b: any) => a.at - a.ms - (b.at - b.ms)) };
}
