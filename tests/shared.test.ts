import { test } from "node:test";
import assert from "node:assert/strict";
import { rankOptions } from "../shared/rank.ts";
import { spell, spokenTime, spokenDate, addDays, traceFrom, departsAt } from "../shared/util.ts";
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

test("rankOptions filters ineligible flights", () => {
  // rankOptions keeps flights departing strictly after notBefore.
  const notBefore = departsAt("2026-10-11", "09:30");
  const flights = [
    flight("ok-a"),
    flight("cancelled", { status: "cancelled" }),
    flight("too-few-seats", { seatsLeft: 1 }),
    flight("other-route", { to: "HKG" }),
    flight("excluded"),
    flight("too-early", { dep: "09:00" }),
    flight("ok-b", { dep: "11:00" }),
  ];
  const opts = { from: "SIN", to: "BKK", pax: 2, notBefore };
  const ranked = rankOptions(flights, { ...opts, exclude: "excluded" }).map((f) => f.id);
  assert.deepEqual(ranked, ["ok-a", "ok-b"]);
});

test("rankOptions sorts by departure and returns at most 3", () => {
  const flights = [
    flight("d", { dep: "13:00" }),
    flight("a", { dep: "08:00" }),
    flight("c", { dep: "11:00" }),
    flight("b", { dep: "09:00" }),
    flight("e", { dep: "15:00" }),
  ];
  const ranked = rankOptions(flights, { from: "SIN", to: "BKK", pax: 1, notBefore: 0 }).map((f) => f.id);
  assert.deepEqual(ranked, ["a", "b", "c"]);
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
