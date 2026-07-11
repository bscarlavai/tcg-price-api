// Set-name matching helpers shared by the mapping tools (build-mapping.js app-set→group,
// coverage.js group→app-set). One implementation so the two views score names identically.

/// Content tokens of a set name: lowercased, a leading "Prefix: " dropped, punctuation stripped,
/// stop-words removed. `stop` is game-specific boilerplate (e.g. Yu-Gi-Oh's "promotional").
export const tokens = (s, stop = new Set()) => new Set(
  (s ?? '').toLowerCase().replace(/^[a-z0-9&.-]+:\s*/, '').replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter((t) => t && !stop.has(t)),
);

export const jaccard = (a, b) => {
  const inter = [...a].filter((t) => b.has(t)).length;
  return inter / (a.size + b.size - inter || 1);
};

/// "ST-30" / "st30" / "ME03" all compare equal.
export const normAbbrev = (s) => (s == null ? null : String(s).toUpperCase().replace(/[^A-Z0-9]/g, '')) || null;
