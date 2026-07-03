// Canonical finish enum (DESIGN.md D9). This is API contract vocabulary — clients key
// off these strings, so they may only ever grow, never change. Source subtype names
// (TCGPlayer "Reverse Holofoil" etc.) must be translated here and never leak to clients.

export const FINISHES = [
  'normal',
  'holo',
  'reverseHolo',
  'firstEdition',
  'firstEditionHolo',
  'unlimited',
  'unlimitedHolo',
  'limited',
  'foil',
];

// TCGPlayer subtype → canonical finish. Unknown subtypes are NOT guessed: the ingest
// audit collects them (see audit.js) so a human adds the mapping deliberately.
export const TCGCSV_SUBTYPES = {
  'Normal': 'normal',
  'Holofoil': 'holo',
  'Reverse Holofoil': 'reverseHolo',
  '1st Edition': 'firstEdition',
  '1st Edition Normal': 'firstEdition',
  '1st Edition Holofoil': 'firstEditionHolo',
  'Unlimited': 'unlimited',
  'Unlimited Normal': 'unlimited',
  'Unlimited Holofoil': 'unlimitedHolo',
  'Limited': 'limited',
  'Foil': 'foil',
  'Cold Foil': 'foil',
};

// Which finish is the headline (top-level market/low in the set blob) when an app shows
// one number. First present wins.
export const DEFAULT_FINISH_ORDER = {
  pokemon:  ['normal', 'holo', 'reverseHolo', 'unlimited', 'unlimitedHolo', 'firstEdition', 'firstEditionHolo'],
  yugioh:   ['normal', 'unlimited', 'firstEdition', 'limited', 'foil'],
  magic:    ['normal', 'foil'],
  onepiece: ['normal', 'foil'],
  lorcana:  ['normal', 'foil'],
  fab:      ['normal', 'foil'],
};
