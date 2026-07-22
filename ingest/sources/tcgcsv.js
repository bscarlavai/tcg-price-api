// TCGCSV source adapter (DESIGN.md §6). The only file that knows TCGCSV's shape.
// Emits canonical rows: { number, name, finish, marketCents, lowCents } — anything a
// replacement source must also produce to pass the golden tests.
//
// v1 fetches per-group endpoints (fine for one game daily). When all six games are
// live, switch the daily pull to the archive (prices-YYYY-MM-DD.ppmd.7z, one download)
// and keep endpoint mode for backfill of products/numbers.

import { TCGCSV_SUBTYPES } from '../lib/finishes.js';

const BASE = 'https://tcgcsv.com/tcgplayer';

export const CATEGORY_IDS = {
  pokemon: 3,
  yugioh: 2,
  magic: 1,
  onepiece: 68,
  lorcana: 71,
  fab: 62, // "Flesh & Blood TCG" — verify before enabling the game
};

// Stamped same-number reprints and oversize products explode row counts without being
// collectable in the usual sense (riplist catalog learnings). Fail-closed skip list.
const DENYLIST = {
  pokemon: /\[(Winner|Staff)\]|Jumbo/i,
  yugioh: /World Championship \d{4}.*Deck|\[(Winner|Staff)\]/i,
  // Tokens share collector numbers with real cards ("Zombie Token (006)" vs Emrakul #6)
  // — Scryfall gives tokens their own set codes, so apps never ask us for them here.
  magic: /\bToken\b/i,
};

// tcgcsv.com/docs usage guidelines: versioned User-Agent, ~100ms between requests
// (they throttle bursty clients for 10 min and may ban >10k req/day). The chain paces
// request *starts* globally, so run.js's concurrent workers still overlap responses.
const UA = 'lavailabs-tcg-price-api/1.0 (github.com/bscarlavai/tcg-price-api)';
const PACE_MS = 100;
let paceChain = Promise.resolve();

// Transient upstream blips (a momentary 503/429 or a dropped connection) used to drop one set,
// shrink coverage, and trip the audit ratchet — failing the whole run over a single flaky group.
// Retry those with exponential backoff so they self-heal in-run. 4xx (except 429) stays fatal:
// a 404 is a real mapping error, not something a retry fixes.
const MAX_ATTEMPTS = 4;
const isTransient = (status) => status === 429 || status >= 500;

async function getJSON(url) {
  for (let attempt = 1; ; attempt++) {
    // Pace every attempt (including retries) through the global chain to honor the rate limit.
    const turn = paceChain.then(() => new Promise((r) => setTimeout(r, PACE_MS)));
    paceChain = turn;
    await turn;

    let res, netErr;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA } });
    } catch (e) {
      netErr = e; // fetch() rejects on network-level failures (DNS, connection reset) — transient
    }
    if (res?.ok) return (await res.json()).results;

    // A 4xx other than 429 (e.g. a 404 from a bad group mapping) is a real error a retry won't fix.
    if (!netErr && !isTransient(res.status)) throw new Error(`${res.status} ${url}`);
    if (attempt >= MAX_ATTEMPTS) throw netErr ?? new Error(`${res.status} ${url}`);

    const backoffMs = 500 * 2 ** (attempt - 1); // 0.5s, 1s, 2s
    console.error(`  ↻ retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoffMs}ms — ${url}`);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
}

export async function listGroups(game) {
  return getJSON(`${BASE}/${CATEGORY_IDS[game]}/groups`);
}

import { normalizeNumber } from '../lib/normalize.js';
export { normalizeNumber };

// productId → card identity. Split out from fetchSetRows so the archive backfill can
// join historical price files (productId-keyed, no metadata) against current products.
export function parseProducts(game, products) {
  const numberById = new Map();
  for (const p of products) {
    const ext = Object.fromEntries((p.extendedData ?? []).map((e) => [e.name, e.value]));
    // No Number + no card-identifying data = sealed product (box, pack); skip. But
    // pre-2002 Magic sets have real cards with no Number at all — keep those (they
    // carry Rarity/OracleText) and key them by name downstream (blob `byName`).
    if (!ext.Number && !ext.Rarity) continue;
    if (DENYLIST[game]?.test(p.name)) continue;
    // Product names carry trailing paren/bracket chunks where variant descriptors AND
    // number disambiguators both live: "Charlotte Katakuri (067) (Alternate Art)" —
    // "(067)" is the number, not a variant (riplist catalog learnings #3/#4). Strip
    // number-only parens first; what remains is the printing descriptor.
    const descriptor = [...p.name.matchAll(/\(([^)]+)\)|\[([^\]]+)\]/g)]
      .map((m) => m[1] ?? m[2])
      .filter((d) => !/^[A-Z]{0,4}[-\s]?\d+[a-z]?$/i.test(d.trim()))
      .join(' / ') || null;
    numberById.set(p.productId, {
      number: normalizeNumber(game, ext.Number),
      name: p.name,
      // Card identity within a set is (number, rarity): products sharing both are the same
      // card in different finishes/patterns (a Pokémon common's Normal base + its reverse-holo
      // "Energy Symbol Pattern" + the Poké Ball / Team Rocket stamp reverse holos all carry
      // one number + one rarity). buildSetBlob uses this to union their subtypes into finishes.
      rarity: ext.Rarity ?? null,
      // The printing descriptor becomes the `variants` key: Konami's rarity name for
      // yugioh ("Quarter Century Secret Rare"), the art descriptor for one piece
      // ("Parallel", "Alternate Art"). Game vocabulary, not source vocabulary.
      variant: game === 'yugioh' ? ext.Rarity ?? null : descriptor,
      isBase: descriptor == null,
    });
  }
  return numberById;
}

// Price records (live endpoint or archive — same shape) × product identity → canonical rows.
export function joinPrices(numberById, prices, { unknownSubtypes } = {}) {
  const rows = [];
  for (const pr of prices) {
    const card = numberById.get(pr.productId);
    // Thin-market vintage often has a lowPrice (cheapest ask) but no marketPrice (no
    // recent sales to average). Keep those rows — the blob carries market:null + low —
    // and drop only cards with no price signal at all.
    if (!card || (pr.marketPrice == null && pr.lowPrice == null)) continue;
    const finish = TCGCSV_SUBTYPES[pr.subTypeName];
    if (!finish) {
      unknownSubtypes?.add(pr.subTypeName);
      continue;
    }
    rows.push({
      productId: pr.productId,   // stable printing id — the key for productId-keyed sets (Secret Lair)
      number: card.number,
      name: card.name,
      rarity: card.rarity,
      finish,
      variant: card.variant,
      isBase: card.isBase,
      marketCents: pr.marketPrice != null ? Math.round(pr.marketPrice * 100) : null,
      lowCents: pr.lowPrice != null ? Math.round(pr.lowPrice * 100) : null,
      // mid/high are the listing midpoint and ceiling. Carried into the blob (not D1 history) so the
      // client can flag a THIN MARKET: an illiquid card's sale-weighted `market` can sit far below what
      // near-mint copies actually list for, and `market` << `mid` is the tell. See normalize.js.
      midCents: pr.midPrice != null ? Math.round(pr.midPrice * 100) : null,
      highCents: pr.highPrice != null ? Math.round(pr.highPrice * 100) : null,
    });
  }
  return rows;
}

export async function fetchProducts(game, groupId) {
  return parseProducts(game, await getJSON(`${BASE}/${CATEGORY_IDS[game]}/${groupId}/products`));
}

export async function fetchSetRows(game, groupId, opts = {}) {
  const [numberById, prices] = await Promise.all([
    fetchProducts(game, groupId),
    getJSON(`${BASE}/${CATEGORY_IDS[game]}/${groupId}/prices`),
  ]);
  return joinPrices(numberById, prices, opts);
}
