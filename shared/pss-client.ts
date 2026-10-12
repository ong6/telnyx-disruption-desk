// Client for the airline's reservation system (desk-pss). Reads go through a short in-process
// cache so a surge of callers asking about the same flights doesn't hammer the system of record;
// writes (rebook, refund, cancel) go straight through. The trace id travels in x-trace-id.
//
// Not KV: measured from a function, a KV read takes 1.2-1.7 s, longer than the reservation call
// it would save (about 300 ms). See DEBUGLOG.md.
import { URLS } from "./endpoints";

export interface PssBooking {
  code: string; first_name: string; last_name: string; phone: string; pax: number; flight: string; date: string;
  tier: string; assistance: string | null; status: string; new_flight: string | null; new_date: string | null;
  confirmation: string | null; refund_ref: string | null;
}
export interface PssFlight { number: string; date: string; dep: string; arr: string; origin: string; dest: string; status: string; capacity: number; sold: number }

const memo = new Map<string, { at: number; ttl: number; text: string }>();
export const clearPssMemo = () => memo.clear();

export function pss(env: any, trace: string, log?: { span: (s: any) => void }) {
  const call = async <T>(path: string, init: RequestInit = {}, cacheSecs = 0): Promise<T> => {
    const t0 = Date.now();
    if (cacheSecs && init.method === undefined) {
      const hit = memo.get(path);
      if (hit && Date.now() - hit.at < hit.ttl * 1000) {
        log?.span({ trace, op: "mem:pss_cache", outcome: "hit", ms: Date.now() - t0, detail: path.replace(/(?<=\/v1\/bookings\/)[^/?]+/, "***").replace(/phone=[^&]+/, "phone=***") });
        return JSON.parse(hit.text) as T;
      }
    }
    const res = await fetch(`${URLS.pss}${path}`, {
      ...init,
      // A wedged reservation system must fail fast, not hang every tool call until Telnyx's
      // own tool timeout burns the caller's hold TTL.
      signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${process.env.PSS_API_KEY}`, "content-type": "application/json", "x-trace-id": trace, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    // Booking codes sit in the request path and phone numbers in the query; neither reaches a
    // trace span, which the operator's console can render.
    const pathForTrace = path.replace(/(?<=\/v1\/bookings\/)[^/?]+/, "***").replace(/phone=[^&]+/, "phone=***");
    log?.span({ trace, op: `pss:${init.method ?? "GET"}`, outcome: res.ok ? "ok" : res.status === 404 ? "not_found" : "error", ms: Date.now() - t0, detail: pathForTrace });
    if (res.status === 404) return null as T;
    if (!res.ok) throw new Error(`pss ${res.status} ${pathForTrace.split("?")[0]}: ${text.slice(0, 200)}`);
    if (cacheSecs && init.method === undefined) memo.set(path, { at: Date.now(), ttl: cacheSecs, text });
    if (init.method !== undefined) memo.clear(); // a write may change what reads return
    return JSON.parse(text) as T;
  };
  return {
    booking: (code: string, cacheSecs = 0) => call<PssBooking | null>(`/v1/bookings/${encodeURIComponent(code.toUpperCase())}`, {}, cacheSecs),
    bookingByPhone: (phone: string) => call<PssBooking | null>(`/v1/bookings?phone=${encodeURIComponent(phone)}`, {}, 20),
    flights: (origin: string, dest: string, from: string, to: string) =>
      call<PssFlight[]>(`/v1/flights?origin=${origin}&dest=${dest}&from=${from}&to=${to}`, {}, 20),
    flight: (number: string, date: string) => call<PssFlight | null>(`/v1/flights/${number}/${date}`, {}, 20),
    rebook: (code: string, body: { flight: string; date: string; confirmation: string; fee: number }) =>
      call<PssBooking>(`/v1/bookings/${code}/rebook`, { method: "POST", body: JSON.stringify(body) }),
    refund: (code: string, reason: string) => call<{ refund_ref: string }>(`/v1/bookings/${code}/refund`, { method: "POST", body: JSON.stringify({ reason }) }),
    cancel: (code: string) => call<{ credit_ref: string }>(`/v1/bookings/${code}/cancel`, { method: "POST", body: "{}" }),
  };
}
