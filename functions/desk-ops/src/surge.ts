// The surge simulator: hundreds of stranded passengers rebooking at once, through the same MCP
// tools the phone assistant calls (find_dates -> find_flights -> hold_seats -> confirm_rebooking, or
// join_waitlist when nothing is left). Runs from an actor alarm in waves, so it isn't bound by a
// request's 60 s limit and the console can watch seats drain live. Voice is not simulated:
// concurrency of calls is the platform's job; this exercises the shared state behind them.
import { StatefulActor } from "@telnyx/edge-runtime";
import { URLS } from "../../../shared/endpoints";

export interface SurgeState {
  running: boolean;
  total: number;
  started: number;
  done: number;
  rebooked: number;
  waitlisted: number;
  raceLost: number; // a hold failed because another caller took the seat first
  errors: number;
  startedAt: number;
  finishedAt?: number;
  perWave: number;
  waitlistFlight: string; // where passengers queue when nothing is left
  queue: string[]; // booking codes not started yet
  codes: string[]; // every booking code this run drove, for the cleanup below
  ms: number[]; // per-caller end-to-end time, last 300
}

const WAVE_MS = 1000;

export class Surge extends StatefulActor {
  async start(codes: string[], seconds: number, waitlistFlight: string): Promise<SurgeState> {
    const s: SurgeState = {
      running: true, total: codes.length, started: 0, done: 0, rebooked: 0, waitlisted: 0, raceLost: 0, errors: 0,
      startedAt: Date.now(), perWave: Math.max(1, Math.ceil(codes.length / Math.max(1, seconds))), waitlistFlight, queue: [...codes], codes, ms: [],
    };
    await this.ctx.storage.put("s", s);
    await this.ctx.storage.setAlarm(Date.now() + 200);
    return s;
  }
  async state(): Promise<Omit<SurgeState, "queue" | "ms" | "codes"> & { p50: number; p95: number } | null> {
    const s = await this.ctx.storage.get<SurgeState>("s");
    if (!s) return null;
    const xs = [...s.ms].sort((a, b) => a - b);
    const pct = (p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
    const { queue: _q, ms: _m, codes: _c, ...rest } = s;
    return { ...rest, p50: pct(0.5), p95: pct(0.95) };
  }

  async alarm(): Promise<void> {
    const s = await this.ctx.storage.get<SurgeState>("s");
    if (!s?.running) return;
    const wave = s.queue.splice(0, s.perWave);
    s.started += wave.length;
    await this.ctx.storage.put("s", s);
    if (s.queue.length) await this.ctx.storage.setAlarm(Date.now() + WAVE_MS);

    const token = await (this.env as any).SECRETS.get("ADMIN_TOKEN");
    const results = await Promise.all(wave.map((code) => passenger(code, token, s.waitlistFlight)));

    const cur = (await this.ctx.storage.get<SurgeState>("s"))!;
    for (const r of results) {
      cur.done += 1;
      cur[r.outcome] += 1;
      if (r.raceLost) cur.raceLost += 1;
      cur.ms = [...cur.ms, r.ms].slice(-300);
    }
    if (cur.done >= cur.total) {
      cur.running = false;
      cur.finishedAt = Date.now();
      // Free the simulated passengers' actor state. A few hundred idle Trip instances are all
      // evicted together a few minutes later, and that eviction wave crashed the actor host
      // once (DEBUGLOG #14): cleared state makes the eviction cheap. Cleared in small batches
      // so the cleanup itself is not the next burst.
      let cleared = 0;
      for (let i = 0; i < cur.codes.length; i += 20) {
        const batch = cur.codes.slice(i, i + 20);
        const done = await Promise.allSettled(batch.map((c) => (this.env as any).TRIP.idFromName(c).reset()));
        cleared += done.filter((r) => r.status === "fulfilled").length;
      }
      console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "surge", ev: "cleanup", cleared }));
    }
    await this.ctx.storage.put("s", cur);
  }
}

type Outcome = "rebooked" | "waitlisted" | "errors";

/** One simulated passenger: pick a date, then a time (usually the earliest of each), hold and
 *  confirm; a lost seat race tries again, and nothing left means the waitlist. */
async function passenger(code: string, token: string, waitlistFlight: string): Promise<{ outcome: Outcome; raceLost: boolean; ms: number }> {
  const t0 = Date.now();
  const call = async (name: string, args: object = {}) => {
    const res = await fetch(`${URLS.mcp}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-test-booking": code, "x-trace-id": `sim-${code}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body: any = await res.json();
    return JSON.parse(body?.result?.content?.[0]?.text ?? "{}");
  };
  let raceLost = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { dates = [] }: { dates?: { date: string }[] } = await call("find_dates");
      if (!dates.length) break;
      const day = dates[Math.random() < 0.7 ? 0 : Math.min(1, dates.length - 1)];
      const { options = [] }: { options?: { flight_id: string }[] } = await call("find_flights", { date: day.date });
      if (!options.length) { raceLost = true; continue; }
      const pick = options[Math.random() < 0.7 ? 0 : Math.min(1, options.length - 1)];
      const held = await call("hold_seats", { flight_id: pick.flight_id });
      if (!held.held) { raceLost = true; continue; }
      const done = await call("confirm_rebooking");
      if (done.confirmed) return { outcome: "rebooked", raceLost, ms: Date.now() - t0 };
    }
    const w = await call("join_waitlist", { flight_id: waitlistFlight });
    return { outcome: w.waitlisted ? "waitlisted" : "errors", raceLost, ms: Date.now() - t0 };
  } catch {
    return { outcome: "errors", raceLost, ms: Date.now() - t0 };
  }
}
