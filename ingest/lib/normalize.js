// Canonical rows → the KV set blob (DESIGN.md §4). Prices are dollars in the blob
// (client-facing), cents in D1 history rows.

import { DEFAULT_FINISH_ORDER } from './finishes.js';

const dollars = (cents) => Math.round(cents) / 100;

export function buildSetBlob(game, setCode, rows, sourceRefs, updatedAt) {
  const byNumber = new Map();
  for (const r of rows) {
    if (!byNumber.has(r.number)) byNumber.set(r.number, {});
    byNumber.get(r.number)[r.finish] = { market: dollars(r.marketCents), low: r.lowCents != null ? dollars(r.lowCents) : null };
  }

  const order = DEFAULT_FINISH_ORDER[game] ?? ['normal'];
  const cards = {};
  for (const [number, finishes] of byNumber) {
    const headline = order.find((f) => finishes[f]) ?? Object.keys(finishes)[0];
    const { [headline]: head, ...rest } = finishes;
    cards[number] = { market: head.market, low: head.low };
    if (Object.keys(rest).length) cards[number].finishes = rest;
    // Headline finish is included in `finishes` too when others exist, so clients that
    // key strictly by finish never need to know the per-game default rule.
    if (Object.keys(rest).length) cards[number].finishes[headline] = head;
  }

  return { game, set: setCode, sourceRefs, updatedAt, currency: 'USD', cards };
}

export function historyRows(game, setCode, rows, date, source) {
  return rows.map((r) => ({
    game, set_code: setCode, number: r.number, finish: r.finish,
    date, market_cents: r.marketCents, low_cents: r.lowCents, source,
  }));
}
