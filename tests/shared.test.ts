import { test } from "node:test";
import assert from "node:assert/strict";
import { departuresOn, eligible, travelDates } from "../shared/rank.ts";
import { changeFee } from "../shared/fees.ts";
import { FLIGHTS, SCHEDULE_DAYS } from "../shared/seed.ts";
import { spell, spokenTime, spokenDate, spokenDay, addDays, traceFrom, departsAt } from "../shared/util.ts";
import type { FlightSnapshot } from "../shared/types.ts";

const base: FlightSnapshot = {
  id: "NB100-2026-10-11",
  number: "NB100",
  date: "2026-10-11",
  dep: "10:00",
  arr: "12:00",
  from: "SIN",
  to: "BKK",
  status: "scheduled",
  capacity: 100,
  seatsLeft: 10,
  held: 0,
  waitlist: 0,
};

const flight = (id: string, over: Partial<FlightSnapshot> = {}): FlightSnapshot => ({ ...base, id, ...over });

test("eligible keeps same-route operating flights after notBefore, earliest first", () => {
  // eligible keeps flights departing strictly after notBefore; full ones stay for the waitlist.
  const notBefore = departsAt("2026-10-11", "09:30");
  const flights = [
    flight("ok-b", { dep: "11:00" }),
    flight("cancelled", { status: "cancelled" }),
    flight("full", { dep: "10:30", seatsLeft: 0 }),
    flight("other-route", { to: "HKG" }),
    flight("excluded"),
    flight("too-early", { dep: "09:00" }),
    flight("ok-a"),
  ];
  const ids = eligible(flights, { from: "SIN", to: "BKK", pax: 2, notBefore, exclude: ["excluded"] }).map((f) => f.id);
  assert.deepEqual(ids, ["ok-a", "full", "ok-b"]);
});

test("travelDates lists only days with a flight that fits the whole party", () => {
  const flights = [
    flight("d1-small", { date: "2026-10-12", seatsLeft: 2 }),
    flight("d2-fits", { date: "2026-10-13", seatsLeft: 4 }),
    flight("d2-also", { date: "2026-10-13", dep: "15:00", seatsLeft: 9 }),
    flight("d3-fits", { date: "2026-10-14", seatsLeft: 30 }),
  ];
  const dates = travelDates(flights, { from: "SIN", to: "BKK", pax: 4, notBefore: 0 });
  assert.deepEqual(dates, [{ date: "2026-10-13", departures: 2 }, { date: "2026-10-14", departures: 1 }]);
});

test("departuresOn splits a day into flights that fit and full ones", () => {
  const flights = [
    flight("late", { date: "2026-10-13", dep: "20:00", seatsLeft: 5 }),
    flight("full", { date: "2026-10-13", dep: "07:00", seatsLeft: 1 }),
    flight("early", { date: "2026-10-13", dep: "09:00", seatsLeft: 5 }),
    flight("other-day", { date: "2026-10-14", seatsLeft: 5 }),
  ];
  const { open, full } = departuresOn(flights, "2026-10-13", { from: "SIN", to: "BKK", pax: 2, notBefore: 0 });
  assert.deepEqual(open.map((f) => f.id), ["early", "late"]);
  assert.deepEqual(full.map((f) => f.id), ["full"]);
});

test("changeFee: 100 dollars per change, free under the typhoon waiver or after our cancellation", () => {
  const hkg = { status: "scheduled", origin: "SIN", dest: "HKG" };
  const nrt = { status: "scheduled", origin: "SIN", dest: "NRT" };
  assert.equal(changeFee(hkg, "normal").amount, 100);
  assert.equal(changeFee(hkg, "typhoon").amount, 0);
  assert.equal(changeFee(hkg, "typhoon").waivedBy, "typhoon_waiver");
  assert.equal(changeFee(nrt, "typhoon").amount, 100); // the waiver covers Hong Kong only
  assert.equal(changeFee({ ...nrt, status: "cancelled" }, "normal").amount, 0);
  assert.equal(changeFee(hkg, null).amount, 100);
});

test("the seed schedule offers several departures a day for a week", () => {
  const hkgTomorrow = FLIGHTS.filter((f) => f.to === "HKG" && f.day === 1);
  assert.ok(hkgTomorrow.length >= 4);
  assert.equal(new Set(FLIGHTS.map((f) => f.day)).size, SCHEDULE_DAYS);
  assert.ok(FLIGHTS.every((f) => f.sold >= 0 && f.sold <= f.capacity));
  assert.ok(hkgTomorrow.some((f) => f.sold === f.capacity), "one flight tomorrow is full, for the waitlist");
});

test("spokenDay names today and tomorrow", () => {
  assert.equal(spokenDay("2026-10-13", "2026-10-12"), "tomorrow, Tuesday the 13th of October");
  assert.equal(spokenDay("2026-10-12", "2026-10-12"), "today, Monday the 12th of October");
  assert.equal(spokenDay("2026-10-15", "2026-10-12"), "Thursday the 15th of October");
});

test("spell maps letters to NATO words and digits to words", () => {
  assert.equal(spell("K7Q"), "Kilo, seven, Quebec");
  assert.equal(spell("ab12"), "Alpha, Bravo, one, two");
});

test("spokenTime renders 12-hour speech", () => {
  assert.equal(spokenTime("14:30"), "2:30 PM");
  assert.equal(spokenTime("09:00"), "9 AM");
  assert.equal(spokenTime("00:15"), "12:15 AM");
});

test("spokenDate renders weekday, ordinal and month", () => {
  assert.equal(spokenDate("2026-10-11"), "Sunday the 11th of October");
  assert.equal(spokenDate("2026-10-01"), "Thursday the 1st of October");
  assert.equal(spokenDate("2026-10-02"), "Friday the 2nd of October");
  assert.equal(spokenDate("2026-10-03"), "Saturday the 3rd of October");
  assert.equal(spokenDate("2026-10-12"), "Monday the 12th of October");
});

test("addDays rolls across a month end", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
});

test("traceFrom accepts a valid traceparent and falls back otherwise", () => {
  const id = "4bf92f3577b34da6a3ce929d0e0e4736";
  assert.equal(traceFrom(`00-${id}-00f067aa0ba902b7-01`, "fallback"), id);
  assert.equal(traceFrom(null, "fallback"), "fallback");
  assert.equal(traceFrom("garbage", "fallback"), "fallback");
  assert.equal(traceFrom("00-not-32-hex-01", "fallback"), "fallback");
});

test("openingOffer always ends with the choices, worded for what we know", async () => {
  const { openingOffer, OFFER_ANYONE } = await import("../functions/desk-dv/src/index.ts");
  assert.equal(openingOffer({}), OFFER_ANYONE);
  assert.match(openingOffer({ name: "Jun", city: "Hong Kong", status: "cancelled" }), /^Hi Jun\. Your flight to Hong Kong is cancelled\. I can rebook you .* for free, cancel it for a full refund, or connect you with a person/);
  assert.match(openingOffer({ name: "Daniel", city: "Tokyo Narita", status: "scheduled" }), /rebook or cancel your flight to Tokyo Narita, or connect you with a person/);
  assert.match(openingOffer({ name: "Jun", rebooked: "Kilo, two" }), /already rebooked, and your confirmation code is Kilo, two/);
  assert.match(openingOffer({ name: "Jun", hold: "NB862-2026-10-13" }), /seat on hold/);
});

test("readConfigFast never throws when the Config actor fails, and serves the last good flags", async () => {
  const { readConfigFast, resetConfigCache } = await import("../shared/config.ts");
  let failing = true;
  const env = { CONFIG: { idFromName: () => ({ get: async () => { if (failing) throw new Error("actor 503"); return { flags: { disruption_mode: "on" }, scenario: null }; } }) } };
  const quiet = console.error;
  console.error = () => {};
  try {
    resetConfigCache();
    assert.equal(await readConfigFast(env, 50), null); // cold and failing: null, not a throw
    failing = false;
    assert.equal((await readConfigFast(env, 500))?.flags.disruption_mode, "on");
    assert.equal((await readConfigFast(env, 500))?.flags.human_queue, "open"); // defaults fill the rest
    failing = true;
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000; // stale: refreshes in the background, which fails
    try {
      assert.equal((await readConfigFast(env, 50))?.flags.disruption_mode, "on");
      await new Promise((r) => setTimeout(r, 20)); // let the failed refresh settle (no unhandled rejection)
    } finally {
      Date.now = realNow;
    }
  } finally {
    console.error = quiet;
    resetConfigCache();
  }
});
