// Stand-in for the airline's schedule and reservation system. Days are relative to the
// scenario's base date so the demo always runs "today". Fictional airline: Nimbus Air (NB).
import type { BookingDef, FlightDef } from "./types";

const route = (number: string, day: number, dep: string, arr: string, capacity: number, sold: number, from = "SIN", to = "HKG"): FlightDef =>
  ({ number, day, dep, arr, from, to, capacity, sold });

export const FLIGHTS: FlightDef[] = [
  // Singapore -> Hong Kong, today: the flights the typhoon cancels
  route("NB862", 0, "09:15", "13:05", 180, 171),
  route("NB866", 0, "14:30", "18:20", 180, 176),
  route("NB868", 0, "20:05", "23:55", 180, 168),
  // Singapore -> Hong Kong, tomorrow and the day after: where people get rebooked
  route("NB862", 1, "09:15", "13:05", 180, 174), // 6 left
  route("NB866", 1, "14:30", "18:20", 180, 176), // 4 left
  route("NB868", 1, "20:05", "23:55", 180, 171), // 9 left
  route("NB862", 2, "09:15", "13:05", 180, 150), // 30 left
  route("NB866", 2, "14:30", "18:20", 180, 160),
  // An unaffected route, for normal-day questions
  route("NB802", 0, "08:40", "16:50", 220, 190, "SIN", "NRT"),
  route("NB802", 1, "08:40", "16:50", 220, 200, "SIN", "NRT"),
];

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
    cancels: [
      { flight: "NB862", day: 0 },
      { flight: "NB866", day: 0 },
      { flight: "NB868", day: 0 },
    ],
  },
};
