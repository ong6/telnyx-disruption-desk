// One JSON line per event, plus a span per hop written to KV so a call's path can be replayed
// (trace/<trace_id>/<ts>-<rand>). Metrics go to the Metrics actor, fire-and-forget.
import { randomBytes } from "node:crypto";

export interface Span {
  trace: string;
  svc: string; // "dv" | "mcp" | "ops" | "flight" | "trip"
  op: string; // "webhook" | "tool:hold_seats" | "kv:flags" | ...
  outcome: string; // "ok" | "error" | "sold_out" | ...
  ms: number;
  at: number;
  detail?: string;
}

export function makeLogger(svc: string, env: any) {
  const write = (fields: Record<string, unknown>) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc, ...fields }));
  return {
    info: (ev: string, fields: Record<string, unknown> = {}) => write({ lvl: "info", ev, ...fields }),
    error: (ev: string, fields: Record<string, unknown> = {}) => write({ lvl: "error", ev, ...fields }),
    /** Record one hop of a call. Never throws, never blocks the caller. */
    span(s: Omit<Span, "svc" | "at"> & { svc?: string }) {
      const span: Span = { svc, at: Date.now(), ...s };
      write({ lvl: span.outcome === "error" ? "error" : "info", ev: "span", ...span });
      if (!span.trace) return;
      const key = `trace/${span.trace}/${span.at}-${randomBytes(2).toString("hex")}`;
      env.KV?.put(key, JSON.stringify(span), { expirationTtl: 86400 }).catch(() => {});
      try {
        env.METRICS?.idFromName("global").record(span).catch(() => {});
      } catch {}
    },
  };
}

export const timer = () => {
  const t0 = Date.now();
  return () => Date.now() - t0;
};
