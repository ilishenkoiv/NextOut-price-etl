// Pure destination planner for the carousel window-price collector.
//
// The historically strongest destinations are checked every day. Everything else is sorted into
// seven stable slices, so consecutive plan dates cover the whole tail exactly once per week without
// a monthly request spike.

export const DEFAULT_TAIL_SLICES = 7;

function epochDay(ymd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!match) throw new Error(`Plan date must be YYYY-MM-DD, received: ${ymd}`);
  const [, year, month, day] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (new Date(ms).toISOString().slice(0, 10) !== ymd) {
    throw new Error(`Plan date must be a real calendar date, received: ${ymd}`);
  }
  return Math.floor(ms / 86400000);
}

export function planWindowDestinations({
  allDests,
  findCount,
  planDate,
  topCount = 50,
  tailSlices = DEFAULT_TAIL_SLICES,
  mode = 'auto',
}) {
  if (!Number.isInteger(topCount) || topCount < 1) throw new Error('topCount must be a positive integer');
  if (!Number.isInteger(tailSlices) || tailSlices < 1) throw new Error('tailSlices must be a positive integer');
  if (!['auto', 'full', 'top-only'].includes(mode)) throw new Error(`Unknown window destination mode: ${mode}`);

  const catalogue = [...new Set(allDests)].sort();
  // Known fare-producing destinations lead by hit count. If an origin has fewer than `topCount`
  // known winners, fill the remaining permanent slots deterministically from the catalogue rather
  // than silently shrinking "top 50" to (say) 48.
  const ranked = catalogue.sort((a, b) => {
    const aKnown = findCount.has(a); const bKnown = findCount.has(b);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (aKnown) return (findCount.get(b) - findCount.get(a)) || (a < b ? -1 : 1);
    return a < b ? -1 : 1;
  });
  const top = ranked.slice(0, topCount);

  // With no history there is no honest way to identify a top set. Preserve the existing safe
  // bootstrap behaviour: ask the whole catalogue once and let the resulting history rank it.
  if (findCount.size === 0 || mode === 'full') {
    return { selected: catalogue, top, tail: catalogue.filter((dest) => !top.includes(dest)), slice: null, bootstrap: findCount.size === 0 };
  }
  if (mode === 'top-only') {
    return { selected: top, top, tail: [], slice: null, bootstrap: false };
  }

  const topSet = new Set(top);
  const wholeTail = catalogue.filter((dest) => !topSet.has(dest));
  const slice = ((epochDay(planDate) % tailSlices) + tailSlices) % tailSlices;
  const tail = wholeTail.filter((_, index) => index % tailSlices === slice);
  return { selected: [...top, ...tail], top, tail, slice, bootstrap: false, wholeTailCount: wholeTail.length };
}
