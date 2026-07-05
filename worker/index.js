// Read API (DESIGN.md §5). KV reads for current prices + movers, D1 for per-card
// history; no upstream calls; no source vocabulary in responses (sourceRefs stripped).
// Set blobs cache 24h; market endpoints cache 1h (they change once per daily ingest,
// and an hour bounds how stale a just-computed board can look).

import { DEFAULT_FINISH_ORDER } from '../ingest/lib/finishes.js';
import { normalizeNumber } from '../ingest/lib/normalize.js';

const CACHE = 'public, max-age=86400';
const CACHE_MARKET = 'public, max-age=3600';
const GAMES = new Set(['pokemon', 'yugioh', 'magic', 'onepiece', 'lorcana', 'fab']);
const WINDOWS = new Set(['7d', '30d']);
const HISTORY_WINDOWS = { '7d': 7, '30d': 30, '90d': 90, '180d': 180 };

const json = (body, status = 200, cache = CACHE) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': status === 200 ? cache : 'no-store' },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Canonical: rip-prices.lavailabs.com/v1/*. An optional /api prefix also works,
    // so the API can be mounted under some host's /api later without breaking clients.
    if (url.pathname === '/api' || url.pathname.startsWith('/api/'))
      url.pathname = url.pathname.slice(4) || '/';
    const q = (name) => url.searchParams.get(name);

    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'rate limited' }, 429);

    if (url.pathname === '/v1/prices' || url.pathname === '/v1/price') {
      const game = q('game');
      let set = q('set');
      if (!GAMES.has(game) || !set) return json({ error: 'game and set required' }, 400);
      // One piece has two app vocabularies for the same sets: dashless "OP12" (Bandai
      // card codes, one-rip) and dashed "OP-12" (Bandai set codes, riplist). Canonical
      // KV keys are dashless; collapse a dash between the leading letters and digits.
      // Combined-set codes like "OP14-EB04" don't match the pattern and pass through.
      if (game === 'onepiece') set = set.toUpperCase().replace(/^([A-Z]+)-(?=\d)/, '$1');

      const blob = await env.PRICES.get(`${game}:${set}`, 'json');
      if (!blob) return json({ error: 'unknown set' }, 404);
      const { sourceRefs, ...publicBlob } = blob;

      if (url.pathname === '/v1/prices') return json(publicBlob);

      // Blob keys use the canonical number form (pokemon: zeros stripped — "DP06"→"DP6");
      // normalize the lookup too so padded app-native forms resolve. /v1/prices callers
      // apply the same rule client-side when joining (docs/API.md).
      const number = normalizeNumber(game, q('number'));
      // Pre-2002 Magic has no collector numbers upstream; clients fall back to `name`.
      const nameKey = q('name')?.toLowerCase().replace(/\s*\(.*\)$/, '').trim();
      const card = (number != null ? publicBlob.cards[number] : null)
        ?? (nameKey ? publicBlob.byName?.[nameKey] : null);
      if (!card) return json({ error: 'unknown card' }, 404);
      return json({ game, set, number, ...card, currency: publicBlob.currency, updatedAt: publicBlob.updatedAt });
    }

    if (url.pathname === '/v1/movers') {
      const game = q('game') ?? 'all', window = q('window') ?? '7d', dir = q('dir');
      if ((game !== 'all' && !GAMES.has(game)) || !WINDOWS.has(window))
        return json({ error: 'game (or "all") and window=7d|30d required' }, 400);
      const board = await env.PRICES.get(`movers:${game}:${window}`, 'json');
      if (!board) return json({ window, computedAt: null, gainers: [], losers: [] }, 200, CACHE_MARKET);
      if (dir === 'gainers' || dir === 'losers')
        return json({ window: board.window, computedAt: board.computedAt, [dir]: board[dir] }, 200, CACHE_MARKET);
      return json(board, 200, CACHE_MARKET);
    }

    if (url.pathname === '/v1/history') {
      const game = q('game'), set = q('set'), number = q('number');
      const days = HISTORY_WINDOWS[q('window') ?? '90d'];
      if (!GAMES.has(game) || !set || !number || !days)
        return json({ error: 'game, set, number required; window=7d|30d|90d|180d' }, 400);
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      let results;
      try {
        ({ results } = await env.HISTORY.prepare(
          `SELECT date, finish, market_cents FROM price_history
           WHERE game=? AND set_code=? AND number=? AND variant=? AND date>=? ORDER BY date`,
        ).bind(game, set, number, q('variant') ?? '', since).all());
      } catch {
        // D1 is briefly unavailable during bulk imports/maintenance. Clients treat
        // this like any failure: keep cached values, retry later.
        return json({ error: 'history temporarily unavailable' }, 503);
      }
      if (!results.length) return json({ error: 'no history for card' }, 404);
      const finishes = new Set(results.map((r) => r.finish));
      const finish = q('finish') ?? (DEFAULT_FINISH_ORDER[game] ?? ['normal']).find((f) => finishes.has(f)) ?? results[0].finish;
      const points = results.filter((r) => r.finish === finish)
        .map((r) => ({ date: r.date, market: r.market_cents / 100 }));
      return json({ game, set, number, finish, window: q('window') ?? '90d', points }, 200, CACHE_MARKET);
    }

    if (url.pathname === '/v1/health') {
      const games = [...GAMES];
      const coverage = await Promise.all(games.map((g) => env.PRICES.get(`meta:coverage:${g}`, 'json')));
      return json({ ok: true, ...Object.fromEntries(games.map((g, i) => [g, coverage[i] ?? 'no ingest yet'])) }, 200, 'no-store');
    }

    return json({ error: 'not found' }, 404);
  },
};
