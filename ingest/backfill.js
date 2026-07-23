// One-time D1 history backfill from TCGCSV's daily archives (DESIGN.md §7 step 3).
// Archives hold prices only (productId-keyed); card identity comes from *current*
// product metadata, fetched once per group and cached — so the whole backfill costs
// TCGCSV one products pass plus one ~4MB archive download per day, all paced.
//
//   node ingest/backfill.js --from 2026-01-05 --to 2026-07-02          # all games
//   node ingest/backfill.js --from ... --to ... --games pokemon,magic  # subset
//
// Output: backfill/sql/YYYY-MM.sql (INSERT OR REPLACE — idempotent, resumable).
// Import:  npx wrangler d1 execute tcg-price-history --remote -y --file backfill/sql/YYYY-MM.sql
// Raw archives land in backfill/archives/ (never re-downloaded; copy to R2 after).

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fetchProducts, CATEGORY_IDS } from './sources/tcgcsv.js';
import { historyRows, canonicalSetKey } from './lib/normalize.js';
import { historyInsertStatements } from './lib/cloudflare.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const from = opt('from'), to = opt('to');
if (!from || !to) { console.error('--from and --to (YYYY-MM-DD) required'); process.exit(1); }
const games = opt('games')?.split(',') ?? ['pokemon', 'yugioh', 'magic', 'onepiece', 'lorcana'];
const SOURCE = 'tcgcsv';
const UA = 'lavailabs-tcg-price-api/1.0 (github.com/bscarlavai/tcg-price-api)';

const root = new URL('../backfill/', import.meta.url);
for (const d of ['archives', 'sql', 'products', 'tmp']) mkdirSync(new URL(d, root), { recursive: true });

// ---- Phase A: productId → card identity per game, from current endpoints (cached) ----
// setCode → groupId → [[productId, card], ...]. Sets/products only ever grow, so a
// stale cache under-covers old dates at worst; delete backfill/products/ to refresh.
const productMaps = {};
for (const game of games) {
  const cache = new URL(`products/${game}.json`, root);
  if (existsSync(cache)) {
    productMaps[game] = JSON.parse(readFileSync(cache, 'utf8'));
  } else {
    const mapping = JSON.parse(readFileSync(new URL(`../mapping/${game}.json`, import.meta.url), 'utf8'));
    const perSet = {};
    let n = 0;
    for (const [setCode, refs] of Object.entries(mapping)) {
      // Discovery / productId-keyed sets (Secret Lair, The List) aren't hand-mapped to a groupId and
      // their history is productId-keyed — skip the archive backfill for now (forward daily ingest
      // accrues their history going forward; a productId-aware backfill is a later step).
      if (refs.discover || refs[SOURCE] == null) continue;
      perSet[setCode] = {};
      for (const gid of [refs[SOURCE]].flat()) {
        perSet[setCode][gid] = [...(await fetchProducts(game, gid))]; // paced in the adapter
        n++;
      }
    }
    productMaps[game] = perSet;
    writeFileSync(cache, JSON.stringify(perSet));
    console.log(`${game}: product maps for ${Object.keys(perSet).length} sets (${n} groups) cached`);
  }
}

// ---- Phase B: one archive per day → history rows → monthly .sql ----
const dates = [];
for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1))
  dates.push(d.toISOString().slice(0, 10));

// Prices join needs subtype names; keep parity with the live path via joinPrices.
const { joinPrices } = await import('./sources/tcgcsv.js');

const unknownSubtypes = new Set();
const doneFile = new URL('sql/.done', root);
const done = new Set(existsSync(doneFile) ? readFileSync(doneFile, 'utf8').split('\n').filter(Boolean) : []);
let totalRows = 0;

for (const date of dates) {
  if (done.has(date)) continue;
  const archive = new URL(`archives/prices-${date}.ppmd.7z`, root);
  if (!existsSync(archive)) {
    const res = await fetch(`https://tcgcsv.com/archive/tcgplayer/prices-${date}.ppmd.7z`, { headers: { 'user-agent': UA } });
    if (!res.ok) { console.error(`  ✗ ${date}: archive ${res.status} — skipped`); continue; }
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    await new Promise((r) => setTimeout(r, 500)); // polite gap between archive pulls
  }

  const tmp = new URL(`tmp/${date}/`, root);
  rmSync(tmp, { recursive: true, force: true });
  execFileSync('7zz', ['x', '-y', `-o${tmp.pathname}`, archive.pathname], { stdio: 'ignore' });

  const rows = [];
  for (const game of games) {
    const cat = CATEGORY_IDS[game];
    for (const [setCode, groups] of Object.entries(productMaps[game])) {
      const setRows = [];
      for (const [gid, entries] of Object.entries(groups)) {
        const priceFile = `${tmp.pathname}${date}/${cat}/${gid}/prices`;
        if (!existsSync(priceFile)) continue; // group didn't exist yet on this date
        const prices = JSON.parse(readFileSync(priceFile, 'utf8')).results;
        setRows.push(...joinPrices(new Map(entries), prices, { unknownSubtypes }));
      }
      // Canonical set_code — matches run.js and the Worker's /v1/history seek (see canonicalSetKey).
      if (setRows.length) rows.push(...historyRows(game, canonicalSetKey(game, setCode), setRows, date, SOURCE));
    }
  }
  rmSync(tmp, { recursive: true, force: true });

  appendFileSync(new URL(`sql/${date.slice(0, 7)}.sql`, root), historyInsertStatements(rows).map((s) => s + ';\n').join(''));
  appendFileSync(doneFile, date + '\n');
  totalRows += rows.length;
  console.log(`  ✓ ${date}: ${rows.length} rows`);
}

console.log(`done: ${totalRows} rows this run → backfill/sql/*.sql`);
if (unknownSubtypes.size) console.log(`unknown subtypes seen (skipped): ${[...unknownSubtypes].join(', ')}`);
