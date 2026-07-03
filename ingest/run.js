// Daily ingest (DESIGN.md §3). Local mode writes blobs to out/ for inspection and
// wrangler-dev seeding; push mode diffs against KV and writes changed sets + D1 history.
//
//   node ingest/run.js --game pokemon                    # local: out/kv/*.json
//   node ingest/run.js --game pokemon --sets me3,me4     # subset (dev)
//   node ingest/run.js --game pokemon --push             # KV + D1 (needs CF_* env)
//   node ingest/run.js --game pokemon --push --force     # override coverage ratchet

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fetchSetRows } from './sources/tcgcsv.js';
import { buildSetBlob, historyRows } from './lib/normalize.js';
import { auditCoverage } from './lib/audit.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes(`--${name}`);

const game = opt('game');
if (!game) { console.error('--game required'); process.exit(1); }
const only = opt('sets')?.split(',');
const push = has('push');
const SOURCE = 'tcgcsv'; // active source for every game today (per-game config when a second source goes live)

const mapping = JSON.parse(readFileSync(new URL(`../mapping/${game}.json`, import.meta.url), 'utf8'));
const sets = Object.entries(mapping).filter(([code]) => !only || only.includes(code));
const updatedAt = new Date().toISOString();
const date = updatedAt.slice(0, 10);

const unknownSubtypes = new Set();
const blobs = [];
let cardCount = 0;
let failures = 0;

// Polite, bounded concurrency against tcgcsv.
const queue = [...sets];
async function workOne() {
  const next = queue.shift();
  if (!next) return;
  const [setCode, refs] = next;
  try {
    const rows = await fetchSetRows(game, refs[SOURCE], { unknownSubtypes });
    if (rows.length) {
      blobs.push({ setCode, blob: buildSetBlob(game, setCode, rows, { [SOURCE]: refs[SOURCE] }, updatedAt), rows });
      cardCount += new Set(rows.map((r) => r.number)).size;
    }
  } catch (e) {
    failures++;
    console.error(`  ✗ ${game}:${setCode} — ${e.message}`);
  }
  return workOne();
}
await Promise.all(Array.from({ length: 4 }, workOne));

console.log(`${game}: ${blobs.length}/${sets.length} sets fetched, ${cardCount} cards priced, ${failures} failures`);
if (failures > sets.length * 0.05) {
  console.error('too many fetch failures — aborting before any write');
  process.exit(1);
}

const coverage = { sets: blobs.length, cards: cardCount, unknownSubtypes: [...unknownSubtypes] };

if (!push) {
  mkdirSync(new URL('../out/kv/', import.meta.url), { recursive: true });
  for (const { setCode, blob } of blobs)
    writeFileSync(new URL(`../out/kv/${game}~${setCode}.json`, import.meta.url), JSON.stringify(blob, null, 1));
  console.log(`wrote out/kv/ (local mode; no KV/D1 writes). coverage=${JSON.stringify(coverage)}`);
  process.exit(0);
}

const { kvGet, kvPutMany, d1InsertHistory } = await import('./lib/cloudflare.js');

const previous = await kvGet(`meta:coverage:${game}`);
auditCoverage(game, previous, coverage, { force: has('force') })
  .forEach((w) => console.warn(`  [forced past] ${w}`));

// Diff: only write sets whose card payload actually changed (KV writes are cheap on
// paid, but unchanged writes would churn updatedAt and defeat client caching honesty).
const changed = [];
const history = [];
for (const { setCode, blob, rows } of blobs) {
  const existing = await kvGet(`${game}:${setCode}`);
  if (!existing || JSON.stringify(existing.cards) !== JSON.stringify(blob.cards)) {
    changed.push([`${game}:${setCode}`, blob]);
  }
  history.push(...historyRows(game, setCode, rows, date, SOURCE));
}

await kvPutMany([...changed, [`meta:coverage:${game}`, coverage]]);
await d1InsertHistory(history);
console.log(`pushed: ${changed.length} changed sets → KV, ${history.length} rows → D1`);
