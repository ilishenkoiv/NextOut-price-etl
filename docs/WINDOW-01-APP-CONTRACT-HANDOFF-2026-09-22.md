# Window 01 handoff — saved-ticket refresh contract (2026-09-22)

Status: exact read-only handoff from ETL Window 02. App files were not edited. The app worktree is
owned by Window 01 and already contains unrelated WIP.

## Confirmed current app behavior

### Roulette

- `src/lib/dailyOriginCheapest.ts::resolveFreshRouletteTicket` walks saved pool candidates and only
  records a reveal after the caller receives `kind:'ok'`.
- A successful empty exact-offer read advances to the next candidate.
- A thrown network/server read currently returns `kind:'error'` immediately and does **not** try the
  remaining saved candidates. This conflicts with the consolidated owner contract.
- `DailyOriginCheapest.destinationId` is optional, but the pool query and `Row` normalizer do not
  select/populate it. Shared-airport place identity is therefore not carried by this contract.
- `sourceUpdatedAt` is returned but `refreshDailyCheapestPrice` does not classify an old observation
  separately from a fresh one.

Required Window 01 interface semantics (names may differ, behavior may not):

```ts
type SavedTicketRefresh =
  | { kind: 'fresh'; ticket: DailyOriginCheapest; observedAt: string }
  | { kind: 'unavailable' }             // successful exact read: row absent
  | { kind: 'failed'; retryable: true } // timeout/network/429/server; storage unchanged
  | { kind: 'stale'; observedAt: string | null }; // known row, not freshly observed
```

For one display attempt, `unavailable`, `failed` and `stale` all skip to the next eligible saved
city. They differ for diagnostics/storage: only `unavailable` may correspond to the server-owned
persistent replacement/exhaustion path; `failed` and `stale` never delete or freshen anything.
Do not expose `TP_TOKEN` or call the partner API from the client. Continue through the existing
Supabase/app data contract. Record reveal/history/quota only after `fresh` returns and the result is
still current/focused. Same positive price is `fresh`; changed positive price, higher or lower, is
also `fresh`.

Required regressions:

1. timeout on candidate A, fresh candidate B -> B is shown, A is not mutated, one reveal for B;
2. unavailable A, fresh B -> B is shown, A does not consume reveal;
3. stale A, fresh B -> B is shown; A keeps its original observation timestamp;
4. no eligible/fresh candidate -> existing honest unavailable/next-eligibility state;
5. failed candidates do not consume 4h/3-per-24h quota or five-other-cities history;
6. identical refreshed price updates observation time and is displayed as success;
7. destination identity, not alternate dates or bare shared IATA, drives repeat spacing.

Schema/interface dependency: before shared-airport places enter roulette, add a nullable
`destination_id` to the persisted pool contract and populate it from a canonical server mapping.
Until that exists, do not invent Zurich/Geneva identity from ZRH/GVA or silently reuse the legacy
resort identity.

### Weekend/holiday carousel

Current source trace:

- `prices.ts::loadWindowPricesFromSupabase` paginates and loads **all** `window_prices` rows;
- `breakWindows.ts` creates device-relevant windows (10-day lead, four-month horizon);
- `breakSlides.ts::buildBreakSlides` selects at most 15 slides from device-local statuses/vibes,
  re-ranking every candidate for every window;
- `BreaksBlock` rebuilds selection when `offersVersion` or `windowPricesVersion` changes, so a price
  refresh can change city membership;
- when spacing has no fitting city, `buildBreakSlides` currently falls back to `ordered[0]`, which
  can bypass its own four-other-slide spacing;
- the current Window 01 WIP already implements the exact -> monthly label -> Check price display
  ladder and tests exact/month/source/freshness boundaries in `breakSlides.integration.test.ts`.

Therefore 4,479 qualifying rows / 2,591 route-date groups are the shared source cache, **not** a
persisted daily ticket selection. The server cannot derive the device's selected 15 because it does
not have wish/dream/never/vibes or personal carousel history.

Required small app contract:

```ts
interface DailyBreakSelection {
  version: 1;
  berlinDay: string;
  origin: string;
  flightType: 'direct' | 'any';
  holidayRegion: string | null;
  selectedAt: string;
  tickets: Array<{
    destinationId: string;
    iata: string;
    start: string;
    end: string;
    flightType: 'direct' | 'any';
    position: number;
  }>;
}
```

Persist one immutable selection per Berlin day and selection key. Price/cache updates may update
only the display facts for those exact keys; they must not rerun city ranking. An explicit change of
origin, flight mode, holiday region or personalization needs a documented key/invalidation rule,
not an accidental rebuild. Preserve destinationId and order. Do not drop a saved city/window when
its exact fare is unavailable.

Display ladder for a saved ticket:

1. fresh exact `window_prices` fare for the same origin/destination/dates/mode;
2. otherwise the same route/mode/month minimum, labeled `from … in [month]`, with its real offer
   dates/month-search action;
3. otherwise `Check price` while retaining the saved city/window.

Monthly fallback must never be stored as an exact window fare, used for weekend Total/budget, or
opened on the weekend's dates. Technical failures preserve the last observation/timestamp but do
not label it fresh. Do not implement another-city reselection; that remains IDEA ONLY.

## Server-membership decision still required

Persisting the device's daily 15 fixes client identity/order, but the server still needs a truthful
refresh membership source. Do not call all 2,591 cache groups “selected.” The owner/PO must choose
one privacy-compatible interface:

- register/deduplicate exact locally selected keys through a bounded server RPC (no reveal history,
  device ID or preferences), then refresh the current union; or
- define a shared server candidate table large enough for local selection and accept/measure its
  union refresh workload.

Window 02 does not choose between them and does not introduce a universal top-N. Until the source
is defined and measured, scheduled window refresh activation remains blocked; roulette/MAIN fixes
can continue independently.
