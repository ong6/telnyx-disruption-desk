// Client for the airline's reservation system (desk-pss). Reads go through a short KV cache so a
// surge of callers asking about the same flights doesn't hammer the system of record; writes
// (rebook, refund) go straight through. The trace id travels in x-trace-id.
import { URLS } from "./endpoints";

export interface PssBooking {
  code: string; first_name: string; last_name: string; phone: string; pax: number; flight: string; date: string;
  tier: string; assistance: string | null; status: string; new_flight: string | null; new_date: string | null;
  confirmation: string | null; refund_ref: string | null;
}
export interface PssFlight { number: string; date: string; dep: string; arr: string; origin: string; dest: string; status: string; capacity: number; sold: number }

export function pss(env: any, trace: string, log?: { span: (s: any) => void }) {
  const call = async <T>(path: string, init: RequestInit = {}, cacheSecs = 0): Promise<T> => {
    const t0 = Date.now();
    const key = `cache/pss${path.replace(/[^A-Za-z0-9/=._-]/g, "_")}`;
    if (cacheSecs && init.method === undefined) {
      const hit = await env.KV.get(key).catch(() => null);
      if (hit) {
        log?.span({ trace, op: "kv:pss_cache", outcome: "hit", ms: Date.now() - t0, detail: path });
        return JSON.parse(hit) as T;
      }
    }
    const res = await fetch(`${URLS.pss}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${process.env.PSS_API_KEY}`, "content-type": "application/json", "x-trace-id": trace, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    log?.span({ trace, op: `pss:${init.method ?? "GET"}`, outcome: res.ok ? "ok" : res.status === 404 ? "not_found" : "error", ms: Date.now() - t0, detail: path });
    if (res.status === 404) return null as T;
    if (!res.ok) throw new Error(`pss ${res.status} ${path}: ${text.slice(0, 200)}`);
    if (cacheSecs && init.method === undefined) env.KV.put(key, text, { expirationTtl: cacheSecs }).catch(() => {});
    return JSON.parse(text) as T;
  };
  return {
    booking: (code: string) => call<PssBooking | null>(`/v1/bookings/${encodeURIComponent(code.toUpperCase())}`),
    bookingByPhone: (phone: string) => call<PssBooking | null>(`/v1/bookings?phone=${encodeURIComponent(phone)}`, {}, 30),
    flights: (origin: string, dest: string, from: string, to: string) =>
      call<PssFlight[]>(`/v1/flights?origin=${origin}&dest=${dest}&from=${from}&to=${to}`, {}, 60),
    flight: (number: string, date: string) => call<PssFlight | null>(`/v1/flights/${number}/${date}`, {}, 30),
    rebook: (code: string, body: { flight: string; date: string; confirmation: string }) =>
      call<PssBooking>(`/v1/bookings/${code}/rebook`, { method: "POST", body: JSON.stringify(body) }),
    refund: (code: string, reason: string) => call<{ refund_ref: string }>(`/v1/bookings/${code}/refund`, { method: "POST", body: JSON.stringify({ reason }) }),
  };
}
