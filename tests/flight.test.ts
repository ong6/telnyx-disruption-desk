import { test } from "node:test";
import assert from "node:assert/strict";
import { Flight } from "../functions/desk-mcp/src/flight.ts";

// Flight is a StatefulActor; these fakes stand in for the actor runtime. Storage is an
// in-memory map, the TRIP binding records seatOffered calls, and Date.now is stubbed so
// holds can be aged past their TTL without sleeping.
const realDateNow = Date.now;
const OFFER_TTL_MS = 15 * 60_000;

function useClock(t: { after(fn: () => void): void }, start = 1_700_000_000_000) {
  let now = start;
  Date.now = () => now;
  t.after(() => {
    Date.now = realDateNow;
  });
  return { now: () => now, travel: (ms: number) => (now += ms) };
}

function fakeStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
    async setAlarm(ms: number) {
      alarm = ms;
    },
    async getAlarm() {
      return alarm;
    },
    async deleteAlarm() {
      alarm = null;
    },
  };
}

interface OfferCall {
  booking: string;
  flightId: string;
  holdId: string;
  expiresAt: number;
}

function fakeEnv(offered: OfferCall[]) {
  return {
    TRIP: {
      idFromName: (booking: string) => ({
        async seatOffered(flightId: string, holdId: string, expiresAt: number) {
          offered.push({ booking, flightId, holdId, expiresAt });
        },
      }),
    },
  };
}

const DEF = {
  id: "NB100-2026-10-11",
  number: "NB100",
  date: "2026-10-11",
  dep: "10:00",
  arr: "12:00",
  from: "SIN",
  to: "BKK",
  status: "scheduled" as const,
};

async function makeFlight(capacity: number, sold = 0) {
  const offered: OfferCall[] = [];
  const flight = new Flight({ id: DEF.id, storage: fakeStorage() } as any, fakeEnv(offered) as any);
  await flight.init({ ...DEF, capacity, sold });
  return { flight, offered };
}

test("holds succeed until seats run out, then sold_out", async (t) => {
  useClock(t);
  const { flight } = await makeFlight(2);
  const h1 = await flight.hold("BKNG01", 1, 60);
  assert.ok(h1.ok);
  assert.equal(h1.seatsLeft, 1);
  const h2 = await flight.hold("BKNG02", 1, 60);
  assert.ok(h2.ok);
  assert.equal(h2.seatsLeft, 0);
  const h3 = await flight.hold("BKNG03", 1, 60);
  assert.deepEqual(h3, { ok: false, reason: "sold_out", seatsLeft: 0 });
});

test("a 4-passenger hold with 3 seats left returns not_enough_seats and holds nothing", async (t) => {
  useClock(t);
  const { flight } = await makeFlight(5, 2);
  const r = await flight.hold("BKNG04", 4, 60);
  assert.ok(!r.ok);
  assert.equal(r.reason, "not_enough_seats");
  assert.equal(r.seatsLeft, 3);
  const s = await flight.snapshot();
  assert.equal(s?.held, 0);
  assert.equal(s?.seatsLeft, 3);
});

test("holding twice for the same booking returns the same hold", async (t) => {
  useClock(t);
  const { flight } = await makeFlight(4);
  const h1 = await flight.hold("BKNG05", 2, 60);
  assert.ok(h1.ok);
  const h2 = await flight.hold("BKNG05", 2, 60);
  assert.ok(h2.ok);
  assert.equal(h2.reused, true);
  assert.equal(h2.holdId, h1.holdId);
  assert.equal(h2.expiresAt, h1.expiresAt);
  const s = await flight.snapshot();
  assert.equal(s?.held, 2); // 2 pax held once, not twice
});

test("confirm moves the hold into confirmed and seatsLeft stays reduced", async (t) => {
  useClock(t);
  const { flight } = await makeFlight(10, 5);
  const h = await flight.hold("BKNG06", 2, 60);
  assert.ok(h.ok);
  assert.equal(h.seatsLeft, 3);
  const c = await flight.confirm(h.holdId, "BKNG06");
  assert.ok(c.ok);
  assert.equal(c.pax, 2);
  assert.equal(c.seatsLeft, 3);
  const s = await flight.snapshot();
  assert.equal(s?.held, 0);
  assert.equal(s?.seatsLeft, 3);
});

test("a hold past its expiresAt cannot be confirmed and its seat is free again", async (t) => {
  const clock = useClock(t);
  const { flight } = await makeFlight(2);
  const h = await flight.hold("BKNG07", 1, 60);
  assert.ok(h.ok);
  clock.travel(61_000);
  const c = await flight.confirm(h.holdId, "BKNG07");
  assert.deepEqual(c, { ok: false, reason: "hold_expired" });
  const s = await flight.snapshot();
  assert.equal(s?.seatsLeft, 2);
  const h2 = await flight.hold("BKNG08", 2, 60);
  assert.ok(h2.ok);
  assert.equal(h2.seatsLeft, 0);
});

test("release frees the seat", async (t) => {
  useClock(t);
  const { flight } = await makeFlight(2);
  const h = await flight.hold("BKNG09", 1, 60);
  assert.ok(h.ok);
  const r = await flight.release(h.holdId);
  assert.equal(r.ok, true);
  assert.equal(r.seatsLeft, 2);
  const s = await flight.snapshot();
  assert.equal(s?.held, 0);
});

test("alarm offers returned seats to the waitlist head via TRIP seatOffered", async (t) => {
  const clock = useClock(t);
  const { flight, offered } = await makeFlight(4, 4);
  const j = await flight.joinWaitlist("BKNG10", 2);
  assert.ok(j.ok);
  assert.equal(j.position, 1);
  const ret = await flight.returnSeats("BKNG11", 2);
  assert.equal(ret.ok, true);
  assert.equal(ret.seatsLeft, 2);
  assert.equal(offered.length, 0); // nothing until the alarm fires
  await flight.alarm();
  assert.equal(offered.length, 1);
  assert.equal(offered[0].booking, "BKNG10");
  assert.equal(offered[0].flightId, DEF.id);
  assert.match(offered[0].holdId, /^offer_/);
  assert.equal(offered[0].expiresAt, clock.now() + OFFER_TTL_MS);
  const s = await flight.snapshot();
  assert.equal(s?.waitlist, 0);
  assert.equal(s?.held, 2);
  assert.equal(s?.seatsLeft, 0);
});
