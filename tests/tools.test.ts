import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../functions/desk-mcp/src/tools.ts";
import { resetConfigCache } from "../shared/config.ts";
import { clearPssMemo } from "../shared/pss-client.ts";

const BOOKING = { code: "K7Q2ZX", first_name: "Jun", last_name: "Ong", phone: "", pax: 1, flight: "NB866", date: "2026-10-16", tier: "gold", assistance: null, status: "active", new_flight: null, new_date: null, confirmation: null, refund_ref: null };
const FLIGHT = { number: "NB866", date: "2026-10-16", dep: "14:30", arr: "18:20", origin: "SIN", dest: "HKG", status: "scheduled", capacity: 180, sold: 100 };

/** One in-memory CallSession per trace, a Trip that knows nothing, a reservation system with one booking. */
function harness(flags: Record<string, string> = {}) {
  const sessions = new Map<string, any>();
  const session = (id: string) => {
    const s = sessions.get(id) ?? { caller: "", booking: "", fails: 0 };
    sessions.set(id, s);
    return {
      get: async () => ({ ...s }),
      bind: async (b: string) => void (s.booking = b),
      attemptsLeft: async () => 3 - s.fails,
      fail: async () => ({ left: 3 - ++s.fails, counted: true }),
    };
  };
  const callbacks: any[] = [];
  const env = {
    CALL: { idFromName: session },
    TRIP: { idFromName: () => ({ get: async () => null, verifyFailed: async () => ({}), escalated: async () => ({}), cancelled: async () => ({}) }) },
    FLIGHT: { idFromName: () => ({ returnSeats: async () => ({}), release: async () => ({}) }) },
    METRICS: { idFromName: () => ({ callbackBooked: async (e: any) => callbacks.push(e) }) },
    CONFIG: { idFromName: () => ({ get: async () => ({ flags, scenario: null }) }) },
  };
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === `/v1/bookings/${BOOKING.code}`) return new Response(JSON.stringify(BOOKING));
    if (path.startsWith("/v1/flights/")) return new Response(JSON.stringify(FLIGHT));
    if (path === `/v1/bookings/${BOOKING.code}/cancel`) return new Response(JSON.stringify({ credit_ref: "CR7K2PQ" }));
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  resetConfigCache();
  clearPssMemo();
  const log = { span() {}, info() {}, error() {} } as any;
  const ctx = (trace: string, args: Record<string, unknown> = {}) => ({ env, claims: { trace, caller: "", booking: "" }, log, args });
  return { ctx, sessions, callbacks };
}

test("a booking tool on a turn whose link was lost verifies inline from booking_code and last_name", async () => {
  const h = harness();
  const v: any = await TOOLS.verify_booking.run(h.ctx("turn-a"), { booking_code: "K7Q2ZX", last_name: "Ong" });
  assert.equal(v.verified, true);
  // The next turn arrives under a new trace with no link (DEBUGLOG #27).
  await assert.rejects(TOOLS.get_trip_status.run(h.ctx("turn-b"), {}), (e: any) => e.code === "not_verified" && /booking_code/.test(e.message));
  const args = { booking_code: "k7q2zx", last_name: "O-N-G" };
  const out: any = await TOOLS.get_trip_status.run(h.ctx("turn-c", args), args);
  assert.equal(out.booking_code, "K7Q2ZX");
  assert.equal(h.sessions.get("turn-c").booking, "K7Q2ZX"); // and the turn is linked from now on
});

test("inline verification with the wrong name counts an attempt and acts on nothing", async () => {
  const h = harness();
  const args = { booking_code: "K7Q2ZX", last_name: "Tan" };
  await assert.rejects(TOOLS.get_trip_status.run(h.ctx("t", args), args), (e: any) => e.code === "not_verified");
  assert.equal(h.sessions.get("t").fails, 1);
  assert.equal(h.sessions.get("t").booking, "");
});

test("every booking tool advertises booking_code and last_name", () => {
  for (const name of ["get_trip_status", "find_dates", "find_flights", "hold_seats", "confirm_rebooking", "request_refund", "cancel_booking", "join_waitlist"]) {
    const props = (TOOLS[name].inputSchema as any).properties;
    assert.ok(props.booking_code && props.last_name, name);
  }
});

test("a caller who chose a callback gets one even while a person is free", async () => {
  const h = harness({ human_queue: "open" });
  const redirected: any = await TOOLS.request_callback.run(h.ctx("t"), { reason: "rebook" });
  assert.equal(redirected.booked, false);
  assert.match(redirected.next, /same turn/);
  const booked: any = await TOOLS.request_callback.run(h.ctx("t"), { reason: "rebook", caller_chose_callback: true });
  assert.equal(booked.booked, true);
  assert.equal(h.callbacks.length, 1);
});

test("cancelling an operating flight refunds the sample 100 Singapore dollars", async () => {
  const h = harness();
  const args = { booking_code: "K7Q2ZX", last_name: "Ong" };
  const out: any = await TOOLS.cancel_booking.run(h.ctx("t", args), args);
  assert.equal(out.cancelled, true);
  assert.equal(out.refund_sgd, 100);
  assert.match(out.say, /refund 100 Singapore dollars/);
  assert.doesNotMatch(out.say, /credit/);
});
