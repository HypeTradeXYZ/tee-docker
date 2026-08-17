// `Math.max(1, x)` reads like a guard and is not one: Math.max(1, NaN) is NaN
// and Math.max(1, Infinity) is Infinity. A clock stepped backwards also yields
// a finite but absurd hint — 86460 seconds against a 60-second window — which a
// client that sleeps on it obeys. Clamp to the window instead of flooring.
export function retryAfterSeconds(deadlineMs: number, nowMs: number, ceilingSec: number): number {
  // Normalize the ceiling too, so a caller cannot reintroduce the defect by
  // passing a fractional, zero, or non-finite bound.
  const ceiling = Number.isFinite(ceilingSec) ? Math.max(1, Math.floor(ceilingSec)) : 1;
  const remaining = Math.ceil((deadlineMs - nowMs) / 1000);
  if (!Number.isFinite(remaining)) return ceiling;
  return Math.min(Math.max(1, remaining), ceiling);
}
