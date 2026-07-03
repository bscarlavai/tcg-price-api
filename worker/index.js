// Read API (DESIGN.md §5). Pure KV reads; no upstream calls; no source vocabulary in
// responses (sourceRefs is stripped). Edge + client cache 24h.

const CACHE = 'public, max-age=86400';
const GAMES = new Set(['pokemon', 'yugioh', 'magic', 'onepiece', 'lorcana', 'fab']);

const json = (body, status = 200, cache = CACHE) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': status === 200 ? cache : 'no-store' },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const q = (name) => url.searchParams.get(name);

    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'rate limited' }, 429);

    if (url.pathname === '/v1/prices' || url.pathname === '/v1/price') {
      const game = q('game'), set = q('set');
      if (!GAMES.has(game) || !set) return json({ error: 'game and set required' }, 400);

      const blob = await env.PRICES.get(`${game}:${set}`, 'json');
      if (!blob) return json({ error: 'unknown set' }, 404);
      const { sourceRefs, ...publicBlob } = blob;

      if (url.pathname === '/v1/prices') return json(publicBlob);

      const number = q('number');
      // Pre-2002 Magic has no collector numbers upstream; clients fall back to `name`.
      const nameKey = q('name')?.toLowerCase().replace(/\s*\(.*\)$/, '').trim();
      const card = (number != null ? publicBlob.cards[number] : null)
        ?? (nameKey ? publicBlob.byName?.[nameKey] : null);
      if (!card) return json({ error: 'unknown card' }, 404);
      return json({ game, set, number, ...card, currency: publicBlob.currency, updatedAt: publicBlob.updatedAt });
    }

    if (url.pathname === '/v1/health') {
      const games = [...GAMES];
      const coverage = await Promise.all(games.map((g) => env.PRICES.get(`meta:coverage:${g}`, 'json')));
      return json({ ok: true, ...Object.fromEntries(games.map((g, i) => [g, coverage[i] ?? 'no ingest yet'])) }, 200, 'no-store');
    }

    return json({ error: 'not found' }, 404);
  },
};
