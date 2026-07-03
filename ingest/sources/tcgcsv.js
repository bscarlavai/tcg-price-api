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

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'lavailabs-tcg-price-api' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()).results;
}

export async function listGroups(game) {
  return getJSON(`${BASE}/${CATEGORY_IDS[game]}/groups`);
}

// Align TCGCSV's printed number with each app's native card key. Verified against the
// actual bundles: pokemon "001/088"→"1"; lorcana "157/204"→"157"; yugioh/onepiece/magic
// print exactly what the apps use ("PHNI-EN059", "ST05-001", "6") — leave verbatim.
// Mismatches surface in the coverage audit, not silently.
export function normalizeNumber(game, raw) {
  if (!raw) return null;
  const head = String(raw).split('/')[0].trim();
  if (game === 'pokemon') {
    const m = head.toUpperCase().match(/^([^0-9]*)0*(\d+)(.*)$/);
    return m ? `${m[1]}${m[2]}${m[3]}` : head.toUpperCase();
  }
  return head;
}

export async function fetchSetRows(game, groupId, { unknownSubtypes } = {}) {
  const cat = CATEGORY_IDS[game];
  const [products, prices] = await Promise.all([
    getJSON(`${BASE}/${cat}/${groupId}/products`),
    getJSON(`${BASE}/${cat}/${groupId}/prices`),
  ]);

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
      // The printing descriptor becomes the `variants` key: Konami's rarity name for
      // yugioh ("Quarter Century Secret Rare"), the art descriptor for one piece
      // ("Parallel", "Alternate Art"). Game vocabulary, not source vocabulary.
      variant: game === 'yugioh' ? ext.Rarity ?? null : descriptor,
      isBase: descriptor == null,
    });
  }

  const rows = [];
  for (const pr of prices) {
    const card = numberById.get(pr.productId);
    if (!card || pr.marketPrice == null) continue;
    const finish = TCGCSV_SUBTYPES[pr.subTypeName];
    if (!finish) {
      unknownSubtypes?.add(pr.subTypeName);
      continue;
    }
    rows.push({
      number: card.number,
      name: card.name,
      finish,
      variant: card.variant,
      isBase: card.isBase,
      marketCents: Math.round(pr.marketPrice * 100),
      lowCents: pr.lowPrice != null ? Math.round(pr.lowPrice * 100) : null,
    });
  }
  return rows;
}
