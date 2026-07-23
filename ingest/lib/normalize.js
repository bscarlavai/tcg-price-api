// Canonical rows → the KV set blob (DESIGN.md §4). Prices are dollars in the blob
// (client-facing), cents in D1 history rows.
//
// Variant printings (same number, separate products upstream): yugioh rarity reprints
// ("Quarter Century Secret Rare"), one piece parallel arts ("Parallel", "Alternate
// Art"). The base printing supplies the headline market/low + finishes; every variant
// appears in `variants` keyed by the game's own printing descriptor, so the app — which
// knows its card's rarity/parallel from its own bundle — picks the right one.

import { DEFAULT_FINISH_ORDER } from './finishes.js';

// Align a source's printed number with each app's native card key. This is GAME
// vocabulary, not source vocabulary — every adapter must normalize into it, and the
// Worker applies the same rule to /v1/price lookups so padded and unpadded forms both
// resolve. Verified against the actual bundles: pokemon "001/088"→"1", "DP06"→"DP6",
// "SWSH001"→"SWSH1" (zero-stripping is deliberate: it's the only form that stays stable
// if a replacement source pads differently — clients join /v1/prices keys via the same
// strip rule, documented in docs/API.md); lorcana "157/204"→"157"; yugioh/onepiece/
// magic print exactly what the apps use ("PHNI-EN059", "ST05-001", "6") — verbatim.
export function normalizeNumber(game, raw) {
  if (!raw) return null;
  const head = String(raw).split('/')[0].trim();
  if (game === 'pokemon') {
    const m = head.toUpperCase().match(/^([^0-9]*)0*(\d+)(.*)$/);
    return m ? `${m[1]}${m[2]}${m[3]}` : head.toUpperCase();
  }
  return head;
}

// Canonical storage identity for a set code: lowercase, so the KV key + D1 set_code a set lives under
// never depends on whether the app or a mapping happened to type it upper- or lower-case (magic/yugioh
// mappings are uppercase, pokemon mostly lowercase, lorcana mixed). One Piece additionally collapses a
// dash between its leading letters and digits ("OP-12"→"op12"); combined-set codes like "OP14-EB04"
// don't match and pass through. This is the SINGLE source of truth — ingest builds keys with it, the
// Worker resolves queries with it, coverage.js audits with it — so the three can't drift (they did:
// the old worker-only lowercase fallback resolved uppercase→lowercase but not the reverse, and the
// coverage audit reported as "unmapped" sets the worker actually served). The blob's `set` field and
// the API response keep the ORIGINAL casing for display; only the storage key is canonical.
export function canonicalSetKey(game, code) {
  if (code == null) return code;
  let c = String(code).trim();
  if (game === 'onepiece') c = c.replace(/^([A-Za-z]+)-(?=\d)/, '$1');
  return c.toLowerCase();
}

const dollars = (cents) => (cents == null ? null : Math.round(cents) / 100);

// The top-level headline price: the chosen headline finish's market/low, plus mid/high so a client can
// flag a thin market on the headline number too. The per-finish `finishes` map carries the same shape.
const headlinePrice = (finishes, headline) => {
  const p = finishes[headline];
  return { market: p.market, low: p.low, mid: p.mid, high: p.high };
};

// Same finish from multiple products (name-keyed art variants, basic lands): keep the
// cheapest — the conservative price when the exact printing is ambiguous. market:null
// means "no recent sales, listing price only" (low = cheapest ask); a real market
// always beats a null one, and among null-market entries the cheapest low wins.
function betterPrice(a, b) {
  if ((a.market != null) !== (b.market != null)) return a.market != null;
  if (a.market != null) return a.market < b.market;
  return (a.low ?? Infinity) < (b.low ?? Infinity);
}

function pickFinishes(rows, order) {
  const finishes = {};
  for (const r of rows) {
    // mid/high ride along with market/low so the client can flag a thin market (see joinPrices). Only
    // market/low decide which row wins per finish (betterPrice) — the winner's mid/high come with it.
    const price = { market: dollars(r.marketCents), low: dollars(r.lowCents),
                    mid: dollars(r.midCents), high: dollars(r.highCents) };
    if (!finishes[r.finish] || betterPrice(price, finishes[r.finish])) finishes[r.finish] = price;
  }
  // Headline prefers a finish with a real market; a low-only finish headlines only
  // when no finish has one (the card then reads market:null, low:<ask>).
  const headline = order.find((f) => finishes[f]?.market != null)
    ?? order.find((f) => finishes[f])
    ?? Object.keys(finishes)[0];
  return { finishes, headline };
}

// Shared key for cards TCGPlayer carries without a collector number (pre-2002 Magic).
// Clients and the history store use the same normalization.
export const nameKey = (name) => name.toLowerCase().replace(/\s*\(.*\)$/, '').trim();

export function buildSetBlob(game, setCode, rows, sourceRefs, updatedAt, keyBy = 'number') {
  const order = DEFAULT_FINISH_ORDER[game] ?? ['normal'];

  // ProductId-keyed sets (Secret Lair, The List): these fold many upstream groups whose collector
  // numbers collide (every drop renumbers from 1), so a number map would serve one printing's price
  // for many cards. Key each printing by its stable TCGplayer productId instead — the app joins by the
  // `tcgplayer_id` it already stores. No `cards`/`byName` map: a number lookup here is worse than a miss.
  if (keyBy === 'productId') {
    const byProductId = new Map();
    for (const r of rows) {
      if (r.productId == null) continue;
      if (!byProductId.has(r.productId)) byProductId.set(r.productId, []);
      byProductId.get(r.productId).push(r);
    }
    const out = {};
    for (const [pid, pidRows] of byProductId) {
      const { finishes, headline } = pickFinishes(pidRows, order);
      out[pid] = { ...headlinePrice(finishes, headline), finishes };
    }
    return { game, set: setCode, sourceRefs, updatedAt, currency: 'USD', keyBy: 'productId', byProductId: out };
  }

  const byNumber = new Map();
  const nameless = new Map(); // pre-2002 Magic: no collector numbers upstream → key by name
  for (const r of rows) {
    if (r.number == null) {
      const key = nameKey(r.name);
      if (!nameless.has(key)) nameless.set(key, []);
      nameless.get(key).push(r);
      continue;
    }
    if (!byNumber.has(r.number)) byNumber.set(r.number, []);
    byNumber.get(r.number).push(r);
  }

  const cards = {};
  for (const [number, numberRows] of byNumber) {
    // Which rows define this card's finishes. Pokémon models a card's reverse holo (and the
    // Poké Ball / Team Rocket stamp reverse holos) as SEPARATE same-number products carrying
    // the Reverse Holofoil subtype — the descriptor-less base product is often Normal-only, so
    // base-only finishes would drop the reverse holo entirely. There the subtype IS the finish,
    // so a card's finishes are the union of every same-(number, rarity) product's subtype
    // (rarity guards against a stray same-number/different-rarity product contaminating it;
    // each finish still prices at its cheapest product via pickFinishes). Other games keep
    // base-only finishes: their descriptors are genuine alt-arts / rarity reprints (One Piece
    // "Alternate Art", Yu-Gi-Oh "Quarter Century Secret Rare") the app tracks as `variants`,
    // not extra finishes of the base card.
    let finishRows;
    if (game === 'pokemon') {
      // Anchor on the base product's rarity (or the first row when no descriptor-less base exists)
      // and union ONLY the same-rarity products — that's the (number, rarity) identity above. A
      // strict equality is deliberate: `rarity == null` escape hatches would re-admit a same-number
      // product of a DIFFERENT card (a Basic Energy, an alt-rarity reprint) whose cheaper subtype
      // would then overwrite this card's real finish price. `null === null` still unions a genuinely
      // rarity-less base with its rarity-less siblings.
      const cardRarity = (numberRows.find((r) => r.isBase) ?? numberRows[0]).rarity;
      finishRows = numberRows.filter((r) => r.rarity === cardRarity);
    } else {
      finishRows = numberRows.some((r) => r.isBase) ? numberRows.filter((r) => r.isBase) : numberRows;
    }
    const { finishes, headline } = pickFinishes(finishRows, order);
    const card = headlinePrice(finishes, headline);
    // Always carry the finishes map — even for a single-finish card. Omitting it for single-finish
    // cards (the old `> 1` guard) lost the finish IDENTITY: a holo-only vintage card looked
    // finish-less, so downstream (add_finishes.py) wrongly guessed `normal` from its price. The
    // finish a card prints must always be explicit, or clients can't tell holo-only from normal.
    card.finishes = finishes;

    const variantKeys = [...new Set(numberRows.map((r) => r.variant).filter(Boolean))];
    if (variantKeys.length) {
      card.variants = {};
      for (const v of variantKeys) {
        const vRows = numberRows.filter((r) => r.variant === v);
        const picked = pickFinishes(vRows, order);
        card.variants[v] = picked.finishes[picked.headline];
      }
    }
    cards[number] = card;
  }

  const blob = { game, set: setCode, sourceRefs, updatedAt, currency: 'USD', cards };
  if (nameless.size) {
    const order2 = DEFAULT_FINISH_ORDER[game] ?? ['normal'];
    blob.byName = {};
    for (const [key, nRows] of nameless) {
      const { finishes, headline } = pickFinishes(nRows, order2);
      const entry = headlinePrice(finishes, headline);
      entry.finishes = finishes;   // always explicit — see buildSetBlob above
      blob.byName[key] = entry;
    }
  }
  return blob;
}

export function historyRows(game, setCode, rows, date, source, keyBy = 'number') {
  // Dedupe on the D1 primary key, keeping the cheapest — mirrors the blob's policy for
  // same-name/same-finish products so history matches what clients were shown.
  // Listing-only rows (market null) stay out of D1: history and movers are strictly
  // sale-derived, so asking-price churn never pollutes charts or leaderboards.
  const byKey = new Map();
  for (const r of rows) {
    if (r.marketCents == null) continue;
    // ProductId-keyed sets (Secret Lair / The List) store the productId in the `number` slot: their
    // collector numbers collide across the folded groups, so productId is the printing identity here
    // too, and they carry no variant. Queries scope by (game, set_code), so the column stays coherent.
    const number = keyBy === 'productId' ? String(r.productId) : (r.number ?? nameKey(r.name));
    const variant = keyBy === 'productId' ? '' : (r.variant ?? '');
    const row = {
      game, set_code: setCode, number, finish: r.finish, variant,
      date, market_cents: r.marketCents, low_cents: r.lowCents, source,
    };
    const key = `${row.number} ${row.finish} ${row.variant}`;
    if (!byKey.has(key) || row.market_cents < byKey.get(key).market_cents) byKey.set(key, row);
  }
  return [...byKey.values()];
}
