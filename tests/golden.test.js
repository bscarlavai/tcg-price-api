// Golden contract tests (DESIGN.md §6): any active source adapter must reproduce these
// known cards within tolerances. Network test against the live source — run via
// `npm run golden`. Ranges are deliberately wide; they catch mapping/normalization
// breakage (wrong set, wrong number, wrong finish, cents/dollars slip), not market drift.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSetRows } from '../ingest/sources/tcgcsv.js';
import { buildSetBlob } from '../ingest/lib/normalize.js';

const GOLDEN = JSON.parse(readFileSync(new URL('./golden/pokemon.json', import.meta.url), 'utf8'));
const mapping = JSON.parse(readFileSync(new URL('../mapping/pokemon.json', import.meta.url), 'utf8'));

for (const g of GOLDEN) {
  test(`pokemon ${g.set} #${g.number} ${g.name} (${g.finish})`, async () => {
    const rows = await fetchSetRows('pokemon', mapping[g.set].tcgcsv, {});
    const blob = buildSetBlob('pokemon', g.set, rows, {}, 'test');
    const card = blob.cards[g.number];
    assert.ok(card, `card ${g.number} missing from ${g.set}`);
    const price = g.finish === 'headline' ? card : card.finishes?.[g.finish];
    assert.ok(price, `finish ${g.finish} missing on ${g.set}#${g.number}`);
    assert.ok(price.market >= g.min && price.market <= g.max,
      `market ${price.market} outside [${g.min}, ${g.max}]`);
  });
}
