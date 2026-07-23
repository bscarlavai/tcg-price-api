// Deterministic (no-network) unit tests for buildSetBlob's finish derivation. The golden tests
// (golden.test.js) fetch live from tcgcsv and pin real cards; these pin the SHAPE of the Pokémon
// finish-union so a same-number contaminant can't silently rewrite a card's finishes/headline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSetBlob } from '../ingest/lib/normalize.js';

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
