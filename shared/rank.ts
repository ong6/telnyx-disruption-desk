// Which flights and dates to offer. Pure functions of the schedule and seat counts: no state.
import type { FlightSnapshot } from "./types";
import { departsAt } from "./util";

export interface RankOpts { from: string; to: string; pax: number; notBefore: number; exclude?: string[] }

/** Flights the booking could move to, earliest first: same route, operating, not excluded,
 *  departing after notBefore. Full ones are kept: they are where the waitlist goes. */
export function eligible(flights: FlightSnapshot[], opts: RankOpts) {
  return flights
    .filter((f) => f.from === opts.from && f.to === opts.to && f.status !== "cancelled" && !(opts.exclude ?? []).includes(f.id))
    .filter((f) => departsAt(f.date, f.dep) > opts.notBefore)
    .sort((a, b) => departsAt(a.date, a.dep) - departsAt(b.date, b.dep));
}

/** Dates with at least one flight that fits the whole party, earliest first. */
export function travelDates(flights: FlightSnapshot[], opts: RankOpts) {
  const byDate = new Map<string, number>();
  for (const f of eligible(flights, opts)) if (f.seatsLeft >= opts.pax) byDate.set(f.date, (byDate.get(f.date) ?? 0) + 1);
  return [...byDate].map(([date, departures]) => ({ date, departures }));
}

/** One date's departures: the ones that fit the party, and the full ones (waitlist candidates). */
export function departuresOn(flights: FlightSnapshot[], date: string, opts: RankOpts) {
  const day = eligible(flights, opts).filter((f) => f.date === date);
  return { open: day.filter((f) => f.seatsLeft >= opts.pax), full: day.filter((f) => f.seatsLeft < opts.pax) };
}
