// Deterministic (no-network) unit tests for buildSetBlob's finish derivation. The golden tests
// (golden.test.js) fetch live from tcgcsv and pin real cards; these pin the SHAPE of the Pokémon
// finish-union so a same-number contaminant can't silently rewrite a card's finishes/headline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSetBlob, canonicalSetKey, looseNameKey } from '../ingest/lib/normalize.js';

test('canonicalSetKey: any case of a set code collapses to one canonical key', () => {
  // The invariant that kills the false-404 class: however the app or a mapping cases a code, the
  // storage key is the same. So an ingest that wrote key K, and a query in any case, meet.
  assert.equal(canonicalSetKey('magic', 'EMN'), 'emn');
  assert.equal(canonicalSetKey('magic', 'emn'), 'emn');
  assert.equal(canonicalSetKey('pokemon', 'MEP'), 'mep');
  assert.equal(canonicalSetKey('pokemon', 'me5'), 'me5');
  assert.equal(canonicalSetKey('yugioh', 'PHNI'), 'phni');
});

test('canonicalSetKey: One Piece collapses the code/number dash, then lowercases', () => {
  assert.equal(canonicalSetKey('onepiece', 'OP-12'), 'op12');
  assert.equal(canonicalSetKey('onepiece', 'OP12'), 'op12');
  assert.equal(canonicalSetKey('onepiece', 'op-12'), 'op12');
  // Combined-set codes don't match the leading-letters-then-digit dash and keep their inner dash.
  assert.equal(canonicalSetKey('onepiece', 'OP14-EB04'), 'op14-eb04');
});

test('canonicalSetKey: null/undefined pass through (no crash on a missing code)', () => {
  assert.equal(canonicalSetKey('magic', null), null);
  assert.equal(canonicalSetKey('magic', undefined), undefined);
});

// Minimal row in the shape joinPrices emits (tcgcsv.js). Cents are the stored unit.
const row = (o) => ({
  productId: o.productId,
  number: o.number,
  name: o.name,
  rarity: o.rarity ?? null,
  finish: o.finish,
  variant: o.variant ?? null,
  isBase: o.isBase ?? false,
  marketCents: o.marketCents ?? null,
  lowCents: o.lowCents ?? null,
  midCents: null,
  highCents: null,
});

test('pokemon: a null-rarity same-number product does not leak into finishes', () => {
  // Houndour (#7, Uncommon) shares normalized number "7" with Basic Darkness Energy (#7, Reverse
  // Holofoil) — a different card that carries a NULL rarity (typical of TCGCSV energy rows). The old
  // `r.rarity == null` escape hatch admitted it, so its cheap reverse-holo hijacked Houndour's
  // reverseHolo finish; the strict `r.rarity === cardRarity` filter now excludes it.
  const rows = [
    row({ productId: 1, number: '7', name: 'Houndour', rarity: 'Uncommon', finish: 'normal', isBase: true, marketCents: 500 }),
    row({ productId: 1, number: '7', name: 'Houndour', rarity: 'Uncommon', finish: 'reverseHolo', isBase: true, marketCents: 900 }),
    row({ productId: 2, number: '7', name: 'Basic Darkness Energy', rarity: null, finish: 'reverseHolo', variant: 'Reverse Holofoil', marketCents: 20 }),
  ];
  const blob = buildSetBlob('pokemon', 'test', rows, {}, 'test');
  const card = blob.cards['7'];
  assert.equal(card.finishes.reverseHolo.market, 9.0, 'reverseHolo must be Houndour price, not the 0.20 energy');
  assert.equal(card.finishes.normal.market, 5.0);
});

test('pokemon: same-number, same-rarity stamped products DO union into finishes', () => {
  // The intended behavior: a card's real reverse-holo/stamp siblings share its (number, rarity) and
  // their subtypes union into one finishes map.
  const rows = [
    row({ productId: 10, number: '25', name: 'Pikachu', rarity: 'Common', finish: 'normal', isBase: true, marketCents: 100 }),
    row({ productId: 11, number: '25', name: 'Pikachu', rarity: 'Common', finish: 'reverseHolo', variant: 'Poké Ball', marketCents: 300 }),
  ];
  const blob = buildSetBlob('pokemon', 'test', rows, {}, 'test');
  const card = blob.cards['25'];
  assert.ok(card.finishes.normal && card.finishes.reverseHolo, 'both finishes present');
  assert.equal(card.finishes.reverseHolo.market, 3.0);
});

test('pokemon: no descriptor-less base — a null-rarity same-number product is still excluded', () => {
  // When no row is the base product, the first row anchors the rarity; a null-rarity sibling (which
  // the old `r.rarity == null` hatch would have admitted) is dropped rather than blanket-unioned.
  const rows = [
    row({ productId: 20, number: '3', name: 'Promo Card', rarity: 'Promo', finish: 'holo', variant: 'Staff', marketCents: 1500 }),
    row({ productId: 21, number: '3', name: 'Unrelated Energy', rarity: null, finish: 'reverseHolo', variant: 'Cosmos', marketCents: 40 }),
  ];
  const blob = buildSetBlob('pokemon', 'test', rows, {}, 'test');
  const card = blob.cards['3'];
  assert.ok(card.finishes.holo, 'anchor-rarity finish kept');
  assert.ok(!card.finishes.reverseHolo, 'different-rarity contaminant excluded from finishes');
});

// --- Collision recovery (byCardName) -------------------------------------------------
// Classic Collection sets reprint cards at their ORIGINAL numbers, so several genuinely
// different cards normalize to one key and all but one vanish from `cards`. Real case:
// me55c #106 is Shining Celebi (106/105), Palkia LV.X (106/106) and M Gardevoir EX
// (106/160); cel25c #15 folds four. These pin that the losers stay reachable.

test('collided number: every distinct card is recoverable by name, and the number says so', () => {
  const rows = [
    row({ productId: 1, number: '106', name: 'Shining Celebi', rarity: 'Classic Collection', finish: 'holo', isBase: true, marketCents: 5206 }),
    row({ productId: 2, number: '106', name: 'Palkia LV.X', rarity: 'Classic Collection', finish: 'holo', isBase: true, marketCents: 2933 }),
    row({ productId: 3, number: '106', name: 'M Gardevoir EX', rarity: 'Classic Collection', finish: 'holo', isBase: true, marketCents: 2099 }),
  ];
  const blob = buildSetBlob('pokemon', 'test', rows, {}, 'test');

  // The bare number keeps serving ONE card — that contract is what every shipped client joins
  // on — but it must admit it is one of several rather than passing silently.
  assert.equal(Object.keys(blob.cards).length, 1);
  assert.equal(blob.cards['106'].ambiguous, true);

  // The two cards the number drops are the whole point: without this map, Shining Celebi's
  // $52.06 is simply absent from the blob and the app shows it as M Gardevoir's $20.99.
  assert.equal(blob.byCardName.shiningcelebi.market, 52.06);
  assert.equal(blob.byCardName.palkialvx.market, 29.33);
  assert.equal(blob.byCardName.mgardevoirex.market, 20.99);
  // Each entry carries the number it collided on, so a client can prove it resolved the card
  // it meant rather than a same-named card elsewhere in the set.
  assert.equal(blob.byCardName.shiningcelebi.number, '106');
  assert.ok(blob.byCardName.shiningcelebi.finishes.holo, 'finishes stay explicit');
});

test('looseNameKey bridges the two sides\' spelling of the same card', () => {
  // TCGplayer writes "Genesect EX (Team Plasma)"; the app bundles write "Genesect-EX". nameKey
  // (frozen — it is a D1 key) matches neither to the other, which would make byCardName miss
  // exactly the cards it exists to recover.
  assert.equal(looseNameKey('Genesect EX (Team Plasma)'), looseNameKey('Genesect-EX'));
  assert.equal(looseNameKey('M Gardevoir EX'), looseNameKey('M Gardevoir-EX'));
  assert.equal(looseNameKey('Metagross (Delta Species)'), looseNameKey('Metagross'));
  assert.equal(looseNameKey("Rocket's Zapdos"), 'rocketszapdos');
  // Distinct cards must stay distinct — the key is loose, not blind.
  assert.notEqual(looseNameKey('Venusaur'), looseNameKey('Venusaur EX'));
});

test('same-name siblings are NOT a collision: reverse holos and alt arts stay one card', () => {
  // The rule keys on distinct NAMES, and looseNameKey strips the trailing parenthetical that
  // marks a printing. So a Pokémon reverse holo and a One Piece "(Alternate Art)" — same card,
  // already served by finishes/variants — must not trip `ambiguous` or bloat byCardName.
  // Measured against real data: 0 of 756 numbers across me5/sv8/base1/cel25/me55 fire this.
  const pk = buildSetBlob('pokemon', 'test', [
    row({ productId: 1, number: '25', name: 'Pikachu', rarity: 'Common', finish: 'normal', isBase: true, marketCents: 100 }),
    row({ productId: 2, number: '25', name: 'Pikachu', rarity: 'Common', finish: 'reverseHolo', variant: 'Reverse Holofoil', marketCents: 300 }),
  ], {}, 'test');
  assert.ok(!pk.cards['25'].ambiguous, 'reverse holo is the same card');
  assert.ok(!pk.byCardName, 'no recovery map when nothing collided');

  const op = buildSetBlob('onepiece', 'test', [
    row({ productId: 3, number: 'OP01-001', name: 'Monkey D. Luffy', rarity: 'Leader', finish: 'normal', isBase: true, marketCents: 400 }),
    row({ productId: 4, number: 'OP01-001', name: 'Monkey D. Luffy (Alternate Art)', rarity: 'Leader', finish: 'normal', variant: 'Alternate Art', marketCents: 9000 }),
  ], {}, 'test');
  assert.ok(!op.cards['OP01-001'].ambiguous, 'alt art is the same card');
  assert.equal(op.cards['OP01-001'].variants['Alternate Art'].market, 90, 'still served as a variant');
});
