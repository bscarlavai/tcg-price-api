// Unit tests for the movers guardrails — pure compute, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMovers } from '../ingest/movers.js';

const row = (set, number, now, then, finish = 'normal') =>
  ({ set_code: set, number, finish, now_c: now, then_c: then });

test('penny cards are floored out even at +200%', () => {
  const { gainers } = computeMovers('pokemon', [row('me3', '1', 3, 1)]);
  assert.equal(gainers.length, 0);
});

test('gainers and losers split and rank by pct·log(abs) blend', () => {
  const { gainers, losers } = computeMovers('pokemon', [
    row('me3', '121', 20000, 15000),  // +$50, +33%
    row('me3', '124', 300, 200),      // +$1, +50% — higher pct, far lower $
    row('base1', '4', 60000, 72000),  // -$120, -16.7%
  ]);
  assert.deepEqual(gainers.map((m) => m.number), ['121', '124']);
  assert.equal(losers[0].number, '4');
  assert.equal(losers[0].absChange, -120);
});

test('headline finish picked per game order, not per row order', () => {
  const { gainers } = computeMovers('pokemon', [
    row('me3', '5', 5000, 100, 'reverseHolo'),
    row('me3', '5', 400, 390, 'normal'),
  ]);
  assert.equal(gainers.length, 1);
  assert.equal(gainers[0].finish, 'normal'); // normal outranks reverseHolo for pokemon
  assert.equal(gainers[0].absChange, 0.1);
});

test('missing window endpoint drops the card (no from-nothing artifacts)', () => {
  const { gainers } = computeMovers('pokemon', [row('me3', '9', 5000, null)]);
  assert.equal(gainers.length, 0);
});
