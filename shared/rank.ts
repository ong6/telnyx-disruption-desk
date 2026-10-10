// Which flights to offer. A pure function of the schedule and seat counts: no state.
import type { FlightSnapshot } from "./types";
import { departsAt } from "./util";

export function rankOptions(flights: FlightSnapshot[], opts: { from: string; to: string; pax: number; notBefore: number; exclude?: string }) {
  return flights
    .filter((f) => f.from === opts.from && f.to === opts.to && f.status !== "cancelled" && f.id !== opts.exclude)
    .filter((f) => departsAt(f.date, f.dep) > opts.notBefore && f.seatsLeft >= opts.pax)
    .sort((a, b) => departsAt(a.date, a.dep) - departsAt(b.date, b.dep))
    .slice(0, 3);
}
