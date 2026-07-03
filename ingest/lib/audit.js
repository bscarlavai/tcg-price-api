// Coverage ratchet (DESIGN.md Q3-resolved): an ingest may never silently cover less
// than the previous run. Counts live in KV under meta:coverage:{game}; a shrinking
// count fails the run (exit non-zero → Actions alerts) unless --force acknowledges a
// real contraction (e.g. a set was intentionally unmapped).

export function auditCoverage(game, previous, current, { force = false } = {}) {
  const problems = [];
  if (previous) {
    if (current.sets < previous.sets)
      problems.push(`mapped sets shrank: ${previous.sets} → ${current.sets}`);
    if (current.cards < previous.cards * 0.98)
      problems.push(`priced cards shrank >2%: ${previous.cards} → ${current.cards}`);
  }
  if (current.unknownSubtypes.length)
    problems.push(`unknown source subtypes (add to finishes.js): ${current.unknownSubtypes.join(', ')}`);

  if (problems.length && !force) {
    throw new Error(`[audit:${game}] REFUSING TO PROMOTE:\n  ${problems.join('\n  ')}`);
  }
  return problems; // surfaced as warnings when forced
}
