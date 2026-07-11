// Coverage report: which TCGCSV groups (available price data) are we NOT ingesting, and which
// catalog sets have no mapping at all? The GROUP-centric complement to build-mapping.js (which is
// app-set→group and therefore blind to groups no app-set pointed at). Reads riplist's CURRENT
// catalog (cards-<game>.json) so a freshly-released set surfaces the day it lands in the pack.
//
// Read-only: prints a report and writes proposals to mapping/<game>.coverage.json. Promote the ones
// you want into mapping/<game>.overrides.json (which build-mapping merges and never overwrites), or
// straight into mapping/<game>.json.
//
// Usage:
//   node tools/coverage.js <game> [catalogDir]
//   catalogDir defaults to the sibling riplist checkout's CardData folder.

import { readFileSync, writeFileSync } from 'node:fs';
import { listGroups, CATEGORY_IDS } from '../ingest/sources/tcgcsv.js';
import { tokens, jaccard } from './lib/match.js';

const [game, catalogArg] = process.argv.slice(2);
if (!game || !CATEGORY_IDS[game]) {
  console.error(`usage: node tools/coverage.js <${Object.keys(CATEGORY_IDS).join('|')}> [catalogDir]`);
  process.exit(1);
}

const catalogDir = catalogArg
  ? (catalogArg.endsWith('/') ? catalogArg : catalogArg + '/')
  : new URL('../../riplist/Riplist/Resources/CardData/', import.meta.url).pathname;

let cards;
try {
  cards = JSON.parse(readFileSync(`${catalogDir}cards-${game}.json`, 'utf8'));
} catch (e) {
  console.error(`Can't read catalog at ${catalogDir}cards-${game}.json — pass the CardData dir as arg 2.\n${e.message}`);
  process.exit(1);
}

// Catalog set_code -> { name, count }.
const appSets = new Map();
for (const c of cards) {
  const code = c.set_code;
  if (!code) continue;
  const e = appSets.get(code) ?? { name: c.set_name ?? code, count: 0 };
  e.count += 1;
  appSets.set(code, e);
}

// Mirror the worker's set-key normalization so a catalog set isn't reported "unmapped" just because
// its app-native code is spelled differently than the mapping key. Only One Piece diverges today
// ("OP-13" → "OP13"); every other game's priceSetKey is the set_code verbatim.
const normalizeSetKey = (g, code) =>
  g === 'onepiece' ? String(code).toUpperCase().replace(/^([A-Z]+)-(?=\d)/, '$1') : code;

const mapping = JSON.parse(readFileSync(new URL(`../mapping/${game}.json`, import.meta.url), 'utf8'));
const mappedGroupIds = new Set(Object.values(mapping).flatMap((v) => [v.tcgcsv].flat()));
const mappedSetCodes = new Set(Object.keys(mapping));

const groups = await listGroups(game);
const appSetTok = [...appSets].map(([code, e]) => ({ code, name: e.name, tok: tokens(e.name) }));

// 1) TCGCSV groups we don't ingest, each with a best-guess catalog set_code.
const unmappedGroups = [];
for (const g of groups) {
  if (mappedGroupIds.has(g.groupId)) continue;
  const gTok = tokens(g.name);
  let best = null;
  for (const s of appSetTok) {
    const score = jaccard(gTok, s.tok);
    if (!best || score > best.score) best = { code: s.code, name: s.name, score };
  }
  const confident = best && best.score >= 0.34;
  unmappedGroups.push({
    groupId: g.groupId,
    group: g.name,
    guessSetCode: confident ? best.code : null,
    guessSetName: confident ? best.name : null,
    score: best ? +best.score.toFixed(2) : 0,
  });
}
unmappedGroups.sort((a, b) => b.score - a.score);

// 2) Catalog sets with NO mapping at all — new sets (e.g. Lorcana set 13) surface here.
const unmappedAppSets = [...appSets]
  .filter(([code]) => !mappedSetCodes.has(normalizeSetKey(game, code)))
  .map(([code, e]) => ({ setCode: code, name: e.name, cards: e.count }))
  .sort((a, b) => b.cards - a.cards);

console.log(`${game}: ${groups.length} TCGCSV groups, ${mappedGroupIds.size} mapped, ${unmappedGroups.length} unmapped`);
console.log('\nUnmapped TCGCSV groups (available price data we do NOT ingest):');
for (const u of unmappedGroups) {
  const guess = u.guessSetCode ? `→ maybe set "${u.guessSetCode}" (${u.guessSetName}, ${u.score})` : `→ no confident catalog match`;
  console.log(`  ${String(u.groupId).padStart(6)}  ${u.group.padEnd(42)} ${guess}`);
}
console.log('\nCatalog sets with NO mapping (won\'t price until mapped):');
for (const s of unmappedAppSets) {
  console.log(`  set ${String(s.setCode).padEnd(6)} ${s.name.padEnd(38)} ${s.cards} cards`);
}

const outPath = new URL(`../mapping/${game}.coverage.json`, import.meta.url);
writeFileSync(outPath, JSON.stringify({ unmappedGroups, unmappedAppSets }, null, 1) + '\n');
console.log(`\nwrote ${unmappedGroups.length} group proposals + ${unmappedAppSets.length} unmapped sets → mapping/${game}.coverage.json`);
