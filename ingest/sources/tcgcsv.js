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

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'lavailabs-tcg-price-api' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()).results;
}

export async function listGroups(game) {
  return getJSON(`${BASE}/${CATEGORY_IDS[game]}/groups`);
}

// TCGPlayer prints numbers like "001/088", "SWSH123", "TG01/TG30". Apps use the short
// form ("1", "TG1"). Take the part before "/", uppercase, and strip leading zeros from
// the trailing digit run. Mismatches surface in the coverage audit, not silently.
export function normalizeNumber(raw) {
  if (!raw) return null;
  const head = String(raw).split('/')[0].trim().toUpperCase();
  const m = head.match(/^([^0-9]*)0*(\d+)(.*)$/);
  return m ? `${m[1]}${m[2]}${m[3]}` : head;
}

export async function fetchSetRows(game, groupId, { unknownSubtypes } = {}) {
  const cat = CATEGORY_IDS[game];
  const [products, prices] = await Promise.all([
    getJSON(`${BASE}/${cat}/${groupId}/products`),
    getJSON(`${BASE}/${cat}/${groupId}/prices`),
  ]);

  const numberById = new Map();
  for (const p of products) {
    const ext = (p.extendedData ?? []).find((e) => e.name === 'Number');
    // Products without a Number are sealed (boxes, packs) — not cards; skip.
    if (ext?.value) numberById.set(p.productId, { number: normalizeNumber(ext.value), name: p.name });
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
      marketCents: Math.round(pr.marketPrice * 100),
      lowCents: pr.lowPrice != null ? Math.round(pr.lowPrice * 100) : null,
    });
  }
  return rows;
}
