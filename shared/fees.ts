// What a change costs. One flat fee per booking, the same for every flight offered, waived when
// the typhoon waiver covers the route or Nimbus Air cancelled the original flight.
export const CHANGE_FEE_SGD = 100;

export interface ChangeFee { amount: number; waivedBy: "typhoon_waiver" | "flight_cancelled" | null; say: string }

export function changeFee(orig: { status: string; origin: string; dest: string }, scenarioId: string | null | undefined): ChangeFee {
  if (scenarioId === "typhoon" && (orig.origin === "HKG" || orig.dest === "HKG"))
    return { amount: 0, waivedBy: "typhoon_waiver", say: "There's no change fee: the Typhoon Koinu waiver covers it." };
  if (orig.status === "cancelled")
    return { amount: 0, waivedBy: "flight_cancelled", say: "There's no change fee, because we cancelled your original flight." };
  return { amount: CHANGE_FEE_SGD, waivedBy: null, say: `The change fee is ${CHANGE_FEE_SGD} Singapore dollars, whichever flight you choose.` };
}
