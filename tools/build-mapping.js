// Auto-matcher: app-native set codes → TCGCSV groupIds (DESIGN.md §4, Q3-resolved).
// Per-game extractors read each app's bundled set list and emit a uniform
// { id, name, date, abbrevs[] }; matching is shared. Confident matches land in
// mapping/{game}.json, the rest in mapping/{game}.review.json for a human.
// mapping/{game}.overrides.json always wins and is merged into the final file.
//
// Usage: node tools/build-mapping.js <game> [setsPath]   (game: pokemon|yugioh|magic|onepiece|lorcana)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { listGroups } from '../ingest/sources/tcgcsv.js';
import { tokens, jaccard, normAbbrev } from './lib/match.js';

const GAMES = {
  pokemon: {
    defaultPath: '../poke-rip/PokeRip/Resources/Bundled/sets.json',
    extract: (s) => ({ id: s.id, name: s.name, date: s.releaseDate?.replaceAll('/', '-'), abbrevs: [s.ptcgoCode] }),
  },
  yugioh: {
    defaultPath: '../ygo-rip/YGORip/Resources/Bundled/sets.json',
    extract: (s) => ({ id: s.code, name: s.name, date: s.tcgDate, abbrevs: [s.code] }),
    // Promo-set names carry boilerplate that TCGCSV group names drop.
    stopTokens: ['yu', 'gi', 'oh', 'promotional', 'promo', 'card', 'cards', 'participation'],
  },
  magic: {
    defaultPath: '../mtg-rip/MTGRip/Resources/Bundled/sets.json',
    extract: (s) => ({ id: s.code, name: s.name, date: s.releaseDate, abbrevs: [s.code] }),
  },
  onepiece: {
    defaultPath: '../one-rip/OneRip/Resources/Bundled/sets.json',
    extract: (s) => ({ id: s.code, name: s.name, date: null, abbrevs: [s.code, s.bracketCode] }),
  },
  lorcana: {
    defaultPath: '../lor-rip/LorRip/Resources/Bundled/sets.json',
    extract: (s) => ({ id: s.id, name: s.name, date: s.releaseDate, abbrevs: [s.id] }),
  },
};

const [game, pathArg] = process.argv.slice(2);
if (!GAMES[game]) {
  console.error(`usage: node tools/build-mapping.js <${Object.keys(GAMES).join('|')}> [setsPath]`);
  process.exit(1);
}
const cfg = GAMES[game];
const setsPath = pathArg ?? new URL(`../../${cfg.defaultPath.replace('../', '')}`, import.meta.url).pathname;

const stop = new Set(GAMES[process.argv[2]]?.stopTokens ?? []);
const days = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86400000;

const parsed = JSON.parse(readFileSync(setsPath, 'utf8'));
const rawSets = Array.isArray(parsed) ? parsed : parsed.data ?? parsed.sets;
const appSets = rawSets.map(cfg.extract);
const groups = await listGroups(game);

// An abbreviation that appears on exactly one group AND one app set is definitive.
const groupAbbrevCount = new Map();
for (const g of groups) {
  const a = normAbbrev(g.abbreviation);
  if (a) groupAbbrevCount.set(a, (groupAbbrevCount.get(a) ?? 0) + 1);
}
const appAbbrevCount = new Map();
for (const s of appSets) {
  for (const a of new Set(s.abbrevs.map(normAbbrev).filter(Boolean)))
    appAbbrevCount.set(a, (appAbbrevCount.get(a) ?? 0) + 1);
}

const mapping = {};
const review = [];
for (const s of appSets) {
  const sTok = tokens(s.name, stop);
  const sAbbrevs = new Set(s.abbrevs.map(normAbbrev).filter(Boolean));
  let best = null;
  for (const g of groups) {
    const gTok = tokens(g.name, stop);
    const gAbbrev = normAbbrev(g.abbreviation);
    let score = 0;
    if (gAbbrev && sAbbrevs.has(gAbbrev)) {
      const unique = groupAbbrevCount.get(gAbbrev) === 1 && appAbbrevCount.get(gAbbrev) === 1;
      score += unique ? 3 : 2;
    }
    score += jaccard(sTok, gTok) * 2;
    if (sTok.size && [...sTok].every((t) => gTok.has(t))) score += 1.5;
    if (s.date && g.publishedOn && days(s.date, g.publishedOn) <= 45) score += 1;
    if (!best || score > best.score) best = { g, score };
  }
  if (best && best.score >= 2.5) {
    mapping[s.id] = { tcgcsv: best.g.groupId, name: best.g.name };
  } else {
    review.push({ id: s.id, name: s.name, abbrevs: s.abbrevs, date: s.date,
                  bestGuess: best ? { groupId: best.g.groupId, name: best.g.name, score: +best.score.toFixed(2) } : null });
  }
}

let overrides = {};
try { overrides = JSON.parse(readFileSync(new URL(`../mapping/${game}.overrides.json`, import.meta.url), 'utf8')); } catch {}
Object.assign(mapping, overrides);
const unresolved = review.filter((r) => !(r.id in overrides));

mkdirSync(new URL('../mapping/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../mapping/${game}.json`, import.meta.url), JSON.stringify(mapping, null, 1) + '\n');
writeFileSync(new URL(`../mapping/${game}.review.json`, import.meta.url), JSON.stringify(unresolved, null, 1) + '\n');
console.log(`${game}: matched ${Object.keys(mapping).length}/${appSets.length} sets; ${unresolved.length} need review → mapping/${game}.review.json`);
