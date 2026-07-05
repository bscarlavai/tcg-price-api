// Golden contract tests (DESIGN.md §6): any active source adapter must reproduce these
// known cards within tolerances. Network test against the live source — run via
// `npm run golden`. Ranges are deliberately wide; they catch mapping/normalization
// breakage (wrong set, wrong number, wrong finish/variant, cents/dollars slip), not
// market drift.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fetchSetRows } from '../ingest/sources/tcgcsv.js';
import { buildSetBlob } from '../ingest/lib/normalize.js';

const goldenDir = new URL('./golden/', import.meta.url);
const blobCache = new Map();
async function blobFor(game, set) {
  const key = `${game}:${set}`;
  if (!blobCache.has(key)) {
    const mapping = JSON.parse(readFileSync(new URL(`../mapping/${game}.json`, import.meta.url), 'utf8'));
    const groupIds = [mapping[set].tcgcsv].flat();
    const rows = (await Promise.all(groupIds.map((id) => fetchSetRows(game, id, {})))).flat();
    blobCache.set(key, buildSetBlob(game, set, rows, {}, 'test'));
  }
  return blobCache.get(key);
}

for (const file of readdirSync(goldenDir).filter((f) => f.endsWith('.json'))) {
  const game = file.replace('.json', '');
  for (const g of JSON.parse(readFileSync(new URL(file, goldenDir), 'utf8'))) {
    test(`${game} ${g.set} ${g.number ?? g.byName} ${g.name} (${g.variant ?? g.finish})`, async () => {
      const blob = await blobFor(game, g.set);
      const card = g.byName ? blob.byName?.[g.byName] : blob.cards[g.number];
      assert.ok(card, `card ${g.number ?? g.byName} missing from ${game}:${g.set}`);
      const price = g.variant ? card.variants?.[g.variant]
        : g.finish === 'headline' ? card
        : card.finishes?.[g.finish];
      assert.ok(price, `${g.variant ?? g.finish} missing on ${game}:${g.set} ${g.number ?? g.byName}`);
      // field:"low" pins listing-only cards (market:null upstream): presence + a sane
      // low is the contract; a market may legitimately appear later, so don't forbid it.
      const field = g.field ?? 'market';
      assert.ok(price[field] >= g.min && price[field] <= g.max,
        `${field} ${price[field]} outside [${g.min}, ${g.max}]`);
    });
  }
}
