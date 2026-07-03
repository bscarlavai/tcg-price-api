// Auto-matcher: app-native set codes → TCGCSV groupIds (DESIGN.md §4, Q3-resolved).
// Pokémon v1: reads poke-rip's bundled sets.json (pokemontcg.io-style ids + ptcgoCode
// + releaseDate) and matches against TCGCSV groups by abbreviation, name tokens, and
// release-date proximity. Confident matches land in mapping/pokemon.json; everything
// else lands in mapping/pokemon.review.json for a human. Overrides in
// mapping/pokemon.overrides.json always win and are merged into the final file.
//
// Usage: node tools/build-mapping.js pokemon /path/to/poke-rip/.../sets.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { listGroups } from '../ingest/sources/tcgcsv.js';

const [game, setsPath] = process.argv.slice(2);
if (game !== 'pokemon' || !setsPath) {
  console.error('usage: node tools/build-mapping.js pokemon <path to poke-rip sets.json>');
  process.exit(1);
}

const tokens = (s) => new Set(
  s.toLowerCase().replace(/^[a-z0-9]+:\s*/, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
);
const jaccard = (a, b) => {
  const inter = [...a].filter((t) => b.has(t)).length;
  return inter / (a.size + b.size - inter || 1);
};
const days = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86400000;

const parsed = JSON.parse(readFileSync(setsPath, 'utf8'));
const appSets = Array.isArray(parsed) ? parsed : parsed.data ?? parsed.sets;
const groups = await listGroups(game);

const mapping = {};
const review = [];
for (const s of appSets) {
  const sTok = tokens(s.name);
  const sDate = s.releaseDate?.replaceAll('/', '-');
  let best = null;
  for (const g of groups) {
    const gTok = tokens(g.name);
    let score = 0;
    if (s.ptcgoCode && g.abbreviation === s.ptcgoCode) score += 2;
    score += jaccard(sTok, gTok) * 2;
    // TCGCSV prefixes era codes ("SM - Cosmic Eclipse"); full containment of the app
    // name's tokens is nearly as strong as an exact name match.
    if ([...sTok].every((t) => gTok.has(t))) score += 1.5;
    if (sDate && g.publishedOn && days(sDate, g.publishedOn) <= 45) score += 1;
    if (!best || score > best.score) best = { g, score };
  }
  if (best && best.score >= 2.5) {
    mapping[s.id] = { tcgcsv: best.g.groupId, name: best.g.name };
  } else {
    review.push({ id: s.id, name: s.name, ptcgoCode: s.ptcgoCode, releaseDate: s.releaseDate,
                  bestGuess: best ? { groupId: best.g.groupId, name: best.g.name, score: +best.score.toFixed(2) } : null });
  }
}

let overrides = {};
try { overrides = JSON.parse(readFileSync(new URL(`../mapping/${game}.overrides.json`, import.meta.url), 'utf8')); } catch {}
Object.assign(mapping, overrides);
const unresolved = review.filter((r) => !(r.id in overrides));
review.length = 0;
review.push(...unresolved);

mkdirSync(new URL('../mapping/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../mapping/${game}.json`, import.meta.url), JSON.stringify(mapping, null, 1) + '\n');
writeFileSync(new URL(`../mapping/${game}.review.json`, import.meta.url), JSON.stringify(review, null, 1) + '\n');
console.log(`matched ${Object.keys(mapping).length}/${appSets.length} sets; ${review.length} need review → mapping/${game}.review.json`);
