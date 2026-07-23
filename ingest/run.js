// Daily ingest (DESIGN.md §3). Local mode writes blobs to out/ for inspection and
// wrangler-dev seeding; push mode diffs against KV and writes changed sets + D1 history.
//
//   node ingest/run.js --game pokemon                    # local: out/kv/*.json
//   node ingest/run.js --game pokemon --sets me3,me4     # subset (dev)
//   node ingest/run.js --game pokemon --push             # KV + D1 (needs CF_* env)
//   node ingest/run.js --game pokemon --push --force     # override coverage ratchet

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fetchSetRows, listGroups } from './sources/tcgcsv.js';
import { buildSetBlob, historyRows, canonicalSetKey } from './lib/normalize.js';
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

// Discovery: some app sets (Secret Lair, The List) fold a growing, fragmented family of upstream
// groups whose collector numbers collide. Rather than hand-list groupIds, resolve them by name from
// the live group list so new drops are ingested automatically. Every set code in a family shares the
// family's full group set (they join by productId, so over-inclusion is harmless).
const DISCOVERY_PATTERNS = {
  'secret-lair': /secret lair/i,
  'the-list': /\bthe list\b/i,
  // Lorcana promos: the app splits them into P1/P2/P3/D23/etc. with their own numbering, but
  // TCGplayer groups them by campaign ("Disney Lorcana Promo Cards", "Disney100 Promos", "D23
  // Promos") — number-misaligned, so they price by productId like Secret Lair.
  'lorcana-promo': /promo/i,
};
const discovered = {};
if (sets.some(([, refs]) => refs.discover)) {
  const groups = await listGroups(game);
  for (const [family, re] of Object.entries(DISCOVERY_PATTERNS))
    discovered[family] = groups.filter((g) => re.test(g.name)).map((g) => g.groupId);
  for (const [code, refs] of sets)
    if (refs.discover && !discovered[refs.discover]?.length)
      console.warn(`  [discovery] ${game}:${code} — no groups matched family "${refs.discover}"`);
}

// Family sets share overlapping groups; fetch each group's rows at most once.
const rowCache = new Map();
const fetchGroup = (id) => {
  if (!rowCache.has(id)) rowCache.set(id, fetchSetRows(game, id, { unknownSubtypes }));
  return rowCache.get(id);
};

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
    const keyBy = refs.keyBy ?? 'number';
    // groupIds come from name-discovery (Secret Lair / The List) or the static ref, which may itself
    // be an array — some app sets fold multiple upstream groups (a host set + its Shiny Vault subset).
    const groupIds = refs.discover ? (discovered[refs.discover] ?? []) : [refs[SOURCE]].flat();
    if (!groupIds.length) return workOne();
    const rows = (await Promise.all(groupIds.map(fetchGroup))).flat();
    if (rows.length) {
      blobs.push({ setCode, blob: buildSetBlob(game, setCode, rows, { [SOURCE]: groupIds }, updatedAt, keyBy), rows });
      cardCount += new Set(rows.map((r) => (keyBy === 'productId' ? r.productId : r.number))).size;
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
const content = (b) => b?.byProductId ?? b?.cards;   // productId-keyed sets carry no `cards` map
for (const { setCode, blob, rows } of blobs) {
  // Store under the canonical (lowercase) key so a query in any case resolves; blob.set keeps the
  // original display casing. See canonicalSetKey — the Worker and coverage.js resolve the same way.
  const kvKey = canonicalSetKey(game, setCode);
  const existing = await kvGet(`${game}:${kvKey}`);
  if (!existing || JSON.stringify(content(existing)) !== JSON.stringify(content(blob))) {
    changed.push([`${game}:${kvKey}`, blob]);
  }
  // Number-keyed by default; productId sets (Secret Lair / The List) record history under productId.
  // set_code is canonical too, so /v1/history seeks match /v1/prices keys.
  history.push(...historyRows(game, kvKey, rows, date, SOURCE, blob.keyBy));
}

await kvPutMany([...changed, [`meta:coverage:${game}`, coverage]]);
await d1InsertHistory(history);
console.log(`pushed: ${changed.length} changed sets → KV, ${history.length} rows → D1`);
