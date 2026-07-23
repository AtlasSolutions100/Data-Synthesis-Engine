/**
 * Split a total amount of cents across keys proportionally to their weights
 * (e.g. hours worked per job). Guarantees the parts sum exactly to
 * `totalCents`: each share is floored and the leftover cents are handed out
 * one at a time in order of largest fractional remainder (ties: larger
 * weight first, then insertion order).
 */
export function splitCentsByWeights(
  totalCents: number,
  weights: { key: string; weight: number }[],
): Map<string, number> {
  const result = new Map<string, number>();
  const positive = weights.filter((w) => w.weight > 0);
  if (totalCents <= 0 || positive.length === 0) {
    for (const w of weights) result.set(w.key, 0);
    return result;
  }
  const totalWeight = positive.reduce((s, w) => s + w.weight, 0);
  let assigned = 0;
  const shares = positive.map((w, i) => {
    const exact = (totalCents * w.weight) / totalWeight;
    const floored = Math.floor(exact);
    assigned += floored;
    return { key: w.key, weight: w.weight, floored, frac: exact - floored, i };
  });
  let leftover = totalCents - assigned;
  const order = [...shares].sort(
    (a, b) => b.frac - a.frac || b.weight - a.weight || a.i - b.i,
  );
  for (const s of order) {
    if (leftover <= 0) break;
    s.floored += 1;
    leftover -= 1;
  }
  for (const w of weights) result.set(w.key, 0);
  for (const s of shares) result.set(s.key, s.floored);
  return result;
}
