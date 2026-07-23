// Read API (DESIGN.md §5). KV reads for current prices + movers, D1 for per-card
// history; no upstream calls; no source vocabulary in responses (sourceRefs stripped).
// Set blobs cache 24h; market endpoints cache 1h (they change once per daily ingest,
// and an hour bounds how stale a just-computed board can look).

import { DEFAULT_FINISH_ORDER } from '../ingest/lib/finishes.js';
import { normalizeNumber, canonicalSetKey } from '../ingest/lib/normalize.js';

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

    // Scan-issue intake (write). The app renders the diagnostic (card crop + OCR + top matches) to an
    // image and POSTs it here when a user reports a card that won't scan. We drop the image in R2 keyed
    // by date, with the game/app/note as object metadata, so the failure corpus is browsable per day.
    if (url.pathname === '/v1/report') {
      // Shared-secret gate (guards both the list + the upload): only the app, or an operator holding the
      // key, gets in. It ships in the binary so it's not unbreakable, but with the strict per-IP limit
      // below it stops casual/bot spam. App Attest is the upgrade path if real abuse shows up.
      if (!env.REPORT_KEY || request.headers.get('x-report-key') !== env.REPORT_KEY)
        return json({ error: 'unauthorized' }, 401);
      // Key-gated admin list — verify reports are landing (newest keys carry game/app/note metadata).
      if (request.method === 'GET') {
        const list = await env.REPORTS.list({ prefix: 'reports/', limit: 200, include: ['customMetadata'] });
        return json({ count: list.objects.length, items: list.objects.map((o) => ({
          key: o.key, size: o.size, uploaded: o.uploaded, ...o.customMetadata })) }, 200, 'no-store');
      }
      if (request.method !== 'POST') return json({ error: 'GET or POST required' }, 405);
      // A MUCH stricter per-IP limit than the 200/min read limiter — reports are occasional, so this
      // caps how many images any single IP can push and keeps the bucket from being spammed/filled.
      const rl = await env.REPORT_LIMITER.limit({ key: ip });
      if (!rl.success) return json({ error: 'rate limited' }, 429);
      const ct = request.headers.get('content-type') || '';
      // Allowlist concrete raster types only — NOT a loose `image/` prefix, which admits
      // image/svg+xml (active content that could execute if an object is ever served back).
      if (!(ct.startsWith('image/jpeg') || ct.startsWith('image/png')))
        return json({ error: 'jpeg or png body required' }, 415);
      // Reject oversized uploads by DECLARED length before buffering, so a huge body can't be read
      // into the isolate just to be dropped (the 1.5 MB cap below only bounds what reaches R2).
      if (parseInt(request.headers.get('content-length') || '0', 10) > 1_500_000)
        return json({ error: 'bad size' }, 413);
      const body = await request.arrayBuffer();
      // The rendered diagnostic is well under 1 MB; cap tight so a single request can't be huge
      // (post-read backstop for a chunked upload that omitted content-length).
      if (body.byteLength === 0 || body.byteLength > 1_500_000) return json({ error: 'bad size' }, 413);
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      // Global daily ceiling (best-effort KV counter, 2-day TTL) — a HARD cap on total images/day across
      // ALL IPs, so even if the app secret leaks and someone rotates IPs past the per-IP limit, they
      // can't run up unbounded R2 cost. Reports are rare in normal use; a few hundred/day is generous.
      const dayKey = `report:count:${day}`;
      const count = parseInt((await env.PRICES.get(dayKey)) || '0', 10);
      if (count >= 500) return json({ error: 'daily cap reached' }, 429);
      const key = `reports/${day}/`
        + `${now.toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`
        + (ct.includes('png') ? '.png' : '.jpg');
      await env.REPORTS.put(key, body, {
        httpMetadata: { contentType: ct },
        // NO client IP here (DESIGN.md §8b — "no PII/GDPR surface"): the key-gated GET list spreads
        // this metadata straight into its response, so a stored IP would be a persisted, re-servable
        // PII surface. Per-IP abuse is already throttled at request time by REPORT_LIMITER without
        // persisting anything. `ua` is app/device diagnostics (which OS/build won't scan), not PII.
        customMetadata: {
          game: (q('game') || '').slice(0, 40),
          app: (q('app') || '').slice(0, 20),
          note: (q('note') || '').slice(0, 240),
          ua: (request.headers.get('user-agent') || '').slice(0, 120),
        },
      });
      await env.PRICES.put(dayKey, String(count + 1), { expirationTtl: 172800 });
      return json({ ok: true, key }, 200, 'no-store');
    }

    if (url.pathname === '/v1/prices' || url.pathname === '/v1/price') {
      const game = q('game');
      const set = q('set');
      if (!GAMES.has(game) || !set) return json({ error: 'game and set required' }, 400);
      // Resolve the KV key through the shared canonical form (lowercase; One Piece "OP-12"→"op12"),
      // so any case the app sends resolves regardless of how the mapping key was typed — see
      // canonicalSetKey. The uppercase retry covers set blobs written BEFORE canonicalization
      // (magic/yugioh/one-piece keys were stored upper-case); a full re-ingest re-keys them
      // lower-case and the retry then rarely fires — one KV read on the common hit.
      const key = canonicalSetKey(game, set);
      let blob = await env.PRICES.get(`${game}:${key}`, 'json');
      if (!blob && key !== key.toUpperCase())
        blob = await env.PRICES.get(`${game}:${key.toUpperCase()}`, 'json');
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
      // INDEXED BY forces a direct seek on the PK prefix (game, set_code, number). Without the
      // hint the planner picks idx_history_date and scans every row for the game in the window —
      // ~7.5s / millions of rows for a 180d Magic lookup (past the client's 8s timeout). With it,
      // ~80ms / ~700 rows. A dedicated composite index would be cleaner but D1 OOMs building one
      // over a table this size; the PK's autoindex already covers the equality prefix.
      const seek = (setCode) => env.HISTORY.prepare(
        `SELECT date, finish, market_cents FROM price_history INDEXED BY sqlite_autoindex_price_history_1
         WHERE game=? AND set_code=? AND number=? AND variant=? AND date>=? ORDER BY date`,
      ).bind(game, setCode, number, q('variant') ?? '', since).all();
      const key = canonicalSetKey(game, set);
      let results;
      try {
        ({ results } = await seek(key));
        // Rows written before canonicalization carry the raw mapping case (upper for magic/yugioh/
        // one-piece). Retry uppercase when the canonical seek is empty — keeps the exact single-seek
        // shape (NOT a COLLATE NOCASE scan, which would defeat the index). New rows are canonical, so
        // this is the uncommon path; a one-time `UPDATE set_code = lower(set_code)` retires it.
        if (!results.length && key !== key.toUpperCase()) ({ results } = await seek(key.toUpperCase()));
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
