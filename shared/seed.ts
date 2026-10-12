// Stand-in for the airline's schedule and reservation system. Days are relative to the
// scenario's base date so the demo always runs "today". Fictional airline: Nimbus Air (NB).
import type { BookingDef, FlightDef } from "./types";

const route = (number: string, day: number, dep: string, arr: string, capacity: number, sold: number, from = "SIN", to = "HKG"): FlightDef =>
  ({ number, day, dep, arr, from, to, capacity, sold });

/** How many days of schedule exist, from today: the rebooking window callers choose from. */
export const SCHEDULE_DAYS = 7;

// Every route flies the same departures every day. Singapore -> Hong Kong is the route the
// typhoon hits; Singapore -> Tokyo is unaffected, for normal-day changes.
const DAILY: [number: string, dep: string, arr: string, capacity: number, from: string, to: string][] = [
  ["NB860", "07:10", "11:00", 180, "SIN", "HKG"],
  ["NB862", "09:15", "13:05", 180, "SIN", "HKG"],
  ["NB864", "11:45", "15:35", 180, "SIN", "HKG"],
  ["NB866", "14:30", "18:20", 180, "SIN", "HKG"],
  ["NB868", "20:05", "23:55", 180, "SIN", "HKG"],
  ["NB802", "08:40", "16:50", 220, "SIN", "NRT"],
  ["NB804", "12:20", "20:30", 220, "SIN", "NRT"],
  ["NB806", "15:05", "23:15", 220, "SIN", "NRT"],
];

// Seats left where the story needs them: today is nearly full, tomorrow is where a typhoon surge
// lands first (one flight already full, for the waitlist), the day after has room. Other days
// follow a fixed pattern, so every scenario load is identical.
const SEATS_LEFT: Record<string, number> = {
  "NB860/0": 5, "NB862/0": 9, "NB864/0": 8, "NB866/0": 4, "NB868/0": 12,
  "NB860/1": 0, "NB862/1": 6, "NB864/1": 3, "NB866/1": 4, "NB868/1": 9,
  "NB860/2": 10, "NB862/2": 30, "NB864/2": 25, "NB866/2": 20, "NB868/2": 15,
  "NB802/0": 30, "NB804/0": 20, "NB806/0": 15, "NB802/1": 20,
};

export const FLIGHTS: FlightDef[] = Array.from({ length: SCHEDULE_DAYS }, (_, day) =>
  DAILY.map(([number, dep, arr, capacity, from, to], i) =>
    route(number, day, dep, arr, capacity, capacity - (SEATS_LEFT[`${number}/${day}`] ?? 20 + ((day * 7 + i * 11) % 30)), from, to),
  ),
).flat();

/** Relief flight the operations team can add during a disruption (console button). */
export const RELIEF_FLIGHT: FlightDef = route("NB870", 1, "07:40", "11:30", 300, 0);

export const BOOKINGS: BookingDef[] = [
  // The demo caller: whoever calls from DEMO_CALLER_NUMBER is recognised as Jun
  { code: "K7Q2ZX", firstName: "Jun", lastName: "Ong", phone: "$DEMO_CALLER", pax: 1, flight: "NB866", day: 0, tier: "gold" },
  // Unknown callers verify with booking code + last name
  { code: "T4M8RA", firstName: "Mei Ling", lastName: "Tan", phone: "+6590000001", pax: 4, flight: "NB862", day: 0, tier: "none" },
  { code: "L9W3PE", firstName: "Siew Hong", lastName: "Lim", phone: "+6590000002", pax: 1, flight: "NB868", day: 0, tier: "none", assistance: "wheelchair to the gate" },
  { code: "R2D5VK", firstName: "Priya", lastName: "Raman", phone: "+6590000003", pax: 2, flight: "NB866", day: 0, tier: "platinum" },
  { code: "H8N6CU", firstName: "Daniel", lastName: "Hughes", phone: "+6590000004", pax: 1, flight: "NB802", day: 0, tier: "silver" },
];

export const AIRLINE = { name: "Nimbus Air", code: "NB", cities: { SIN: "Singapore", HKG: "Hong Kong", NRT: "Tokyo Narita" } as Record<string, string> };

export const INCIDENTS: Record<string, { notice: string; cancels: { flight: string; day: number }[] }> = {
  typhoon: {
    notice:
      "Typhoon Koinu has closed Hong Kong International Airport. All Nimbus Air flights from Singapore to Hong Kong today are cancelled.",
    cancels: DAILY.filter(([, , , , , to]) => to === "HKG").map(([flight]) => ({ flight, day: 0 })),
  },
};
