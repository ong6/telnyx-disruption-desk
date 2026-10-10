// Live counters for the ops console: per-minute buckets of events, outcomes and latency, plus
// the last few calls. Counters are read-modify-write from every request at once, which KV would
// silently lose (last write wins). One actor is fine at demo volume; shard by minute at scale.
import { StatefulActor } from "@telnyx/edge-runtime";
import type { Span } from "../../../shared/log";

interface Bucket {
  minute: number;
  counts: Record<string, number>; // "dv:webhook:ok" -> n
  lat: Record<string, number[]>; // "mcp:tool:hold_seats" -> recent ms samples (max 200)
}
interface CallRow { trace: string; at: number; caller: string; booking: string; last: string; outcome: string }

export class Metrics extends StatefulActor {
  async record(span: Span): Promise<void> {
    const minute = Math.floor(span.at / 60_000);
    const buckets = (await this.ctx.storage.get<Bucket[]>("b")) ?? [];
    let b = buckets.find((x) => x.minute === minute);
    if (!b) buckets.push((b = { minute, counts: {}, lat: {} }));
    const key = `${span.svc}:${span.op}`;
    b.counts[`${key}:${span.outcome}`] = (b.counts[`${key}:${span.outcome}`] ?? 0) + 1;
    (b.lat[key] ??= []).push(span.ms);
    if (b.lat[key].length > 200) b.lat[key].shift();
    await this.ctx.storage.put("b", buckets.filter((x) => x.minute > minute - 60));
  }

  async callStarted(row: CallRow): Promise<void> {
    const calls = (await this.ctx.storage.get<CallRow[]>("calls")) ?? [];
    await this.ctx.storage.put("calls", [row, ...calls.filter((c) => c.trace !== row.trace)].slice(0, 25));
  }
  async callUpdated(trace: string, last: string, outcome?: string): Promise<void> {
    const calls = (await this.ctx.storage.get<CallRow[]>("calls")) ?? [];
    const c = calls.find((x) => x.trace === trace);
    if (!c) return;
    c.last = last;
    if (outcome) c.outcome = outcome;
    await this.ctx.storage.put("calls", calls);
  }

  async summary(minutes = 15) {
    const now = Math.floor(Date.now() / 60_000);
    const buckets = ((await this.ctx.storage.get<Bucket[]>("b")) ?? []).filter((b) => b.minute > now - minutes);
    const counts: Record<string, number> = {};
    const lat: Record<string, number[]> = {};
    for (const b of buckets) {
      for (const [k, v] of Object.entries(b.counts)) counts[k] = (counts[k] ?? 0) + v;
      for (const [k, v] of Object.entries(b.lat)) (lat[k] ??= []).push(...v);
    }
    const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
    const latency = Object.fromEntries(Object.entries(lat).map(([k, xs]) => [k, { n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: Math.max(...xs) }]));
    const lastMinute = buckets.find((b) => b.minute === now) ?? buckets.find((b) => b.minute === now - 1);
    const errorsLastMinute = lastMinute ? Object.entries(lastMinute.counts).filter(([k]) => k.endsWith(":error")).reduce((n, [, v]) => n + v, 0) : 0;
    return { minutes, counts, latency, errorsLastMinute, calls: (await this.ctx.storage.get<CallRow[]>("calls")) ?? [] };
  }

  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
