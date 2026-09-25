// Pure day-bucket budget math for the ControlPlane DO (Task 22). No storage
// or bindings here — the DO calls these inside its transactionSync with
// concrete values, so every decision is unit-testable without a database.
//
// Day buckets are UTC calendar days ("2026-09-22"): a new day is a new
// budget_days row, so yesterday's reservations can never double-count into
// today. The `day` is always supplied by the caller (rooms derive it from
// their own clock seam) — this module never reads Date.now() itself.
export const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const utcDay = (nowMs: number): string => {
  if (!Number.isFinite(nowMs)) throw new RangeError("nowMs must be finite");
  return new Date(nowMs).toISOString().slice(0, 10);
};

// Strict shape + real calendar date (rejects "2026-13-40" style strings).
export const isValidDay = (day: string): boolean => {
  if (!DAY_PATTERN.test(day)) return false;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(parsed) && utcDay(parsed) === day;
};

// Reservation kinds. "jev"/"jev-final" share the Jev daily budget; the
// terminal distinction exists so the ledger shows settle-path spending.
// "generation" is the normal-LLM budget — a SEPARATE counter per the
// contract (Jevと通常生成の予算は別counterであり混算しない).
export type ReservationKind = "jev" | "jev-final" | "generation";
export const RESERVATION_KINDS: ReadonlySet<string> = new Set(["jev", "jev-final", "generation"]);

export const parseReservationKind = (kind: string): ReservationKind | null =>
  kind === "jev" || kind === "jev-final" || kind === "generation" ? kind : null;

export type ReservationState = "reserved" | "consumed" | "released";

export type ReserveDenial = "daily-cap" | "released" | "config" | "bad-request";
export type MutateResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };
export type ReserveResult =
  | { readonly ok: true; readonly day: string; readonly kind: ReservationKind }
  | { readonly ok: false; readonly reason: ReserveDenial };

// The pure verdict for one reserve() call: an existing reservation row makes
// the request an idempotent replay (same token, same grant — a room that
// lost the first response retries safely and never double-spends). A
// released token stays dead forever: the job already concluded, so a
// re-grant could send a second upstream call for one budget slot.
export type ReserveDecision = "grant" | "deny-cap" | "deny-released";

export const decideReservation = (
  cap: number,
  dayReserved: number,
  existing: ReservationState | null,
): ReserveDecision => {
  if (existing === "released") return "deny-released";
  if (existing !== null) return "grant"; // idempotent replay of a live grant
  return dayReserved < cap ? "grant" : "deny-cap";
};

// A cap binding must be an explicit positive integer; anything else is a
// fail-closed "config" denial — the real API stays forbidden by default.
export const parseCap = (raw: string | undefined): number | null => {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
