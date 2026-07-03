// Convert out/kv/*.json blobs into wrangler's `kv bulk put` format, including the
// meta:coverage key the audit ratchet reads. Used for the first manual seed; daily
// pushes go through ingest --push (REST, from Actions).
//
// Usage: node tools/kv-bulk-file.js pokemon > out/bulk.json

import { readFileSync, readdirSync } from 'node:fs';

const game = process.argv[2];
const dir = new URL('../out/kv/', import.meta.url);
const pairs = [];
let sets = 0, cards = 0;
for (const f of readdirSync(dir).filter((f) => f.startsWith(`${game}~`) && f.endsWith('.json'))) {
  const blob = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  pairs.push({ key: `${blob.game}:${blob.set}`, value: JSON.stringify(blob) });
  sets++; cards += Object.keys(blob.cards).length;
}
pairs.push({ key: `meta:coverage:${game}`, value: JSON.stringify({ sets, cards, unknownSubtypes: [] }) });
console.log(JSON.stringify(pairs));
