# Pilot market/time-of-day priority cadence — app-side contract (blocking)

**Status: server-side mechanism is implemented, tested, and OFF by default
(`PRIORITY_MARKET_SCHEDULE` unset). Do not turn it on in production until the app-side
work below is done and verified — see "Why this is blocking".**

## What the pilot changes, server-side

`scripts/priority-market-schedule.mjs` (this PR). Per already-selected origin (membership/rank/
dest/dates are still decided once a day by the existing daily selection — this never changes
that), the price-only refresh cadence becomes:

| Local market time (origin airport as proxy) | Cadence |
|---|---|
| DACH 19:00–23:00 / rest of Europe 18:00–23:00 | every 30 minutes (unchanged from today) |
| 07:00 until the peak window above starts | every 2 hours |
| 23:00–07:00 | no priority refresh at all — only MAIN/FAST/TAIL run |

Consequence: `daily_origin_cheapest_pool.source_updated_at` / `window_prices.updated_at` for a
given ticket can now be **legitimately up to ~2 hours old during the day, and up to ~8 hours
old overnight** — even with the pilot working exactly as designed. This is new: under the
current always-on 30-minute schedule, the worst case (measured 2026-09-24) was already several
hours old due to a separate bug (PR #23, being fixed there), but the *design intent* was always
"fresh within 30 minutes." Under this pilot, multi-hour age is the **intended, correct** state
for a large fraction of the day.

## Why this is blocking

Read directly from the app source (this repo's sibling `NextOut-app-active`), as of this
writing:

- **Carousel** — `src/lib/prices.ts`, `loadWindowPricesFromSupabase()`: the `.select(...)` on
  `window_prices` does not even fetch `updated_at`. There is no age check anywhere on this path.
- **Roulette list** — `src/lib/dailyOriginCheapest.ts`, `loadBestDailyOriginCheapestHistory()`:
  picks the latest `snapshot_at`/`source_updated_at` row per origin; again, no age check.
- **Roulette reveal** — `src/lib/dailyOriginCheapest.ts`, `refreshDailyCheapestPrice()`: reads the
  single latest `offers` row for the exact ticket and returns it unconditionally — no check that
  `updated_at` is recent. The caller (`src/components/HeaderRoulettePanel.tsx`) uses the result
  directly with only a null check.

**None of these three paths have ANY existing freshness gate today.** Enabling this pilot without
first adding one would silently show and let users act on multi-hour-old prices with zero
indication anything is stale — a materially worse UX regression than today's bug, which at least
degrades toward "usually still under a couple hours," not "up to 8 hours by design."

## Exact contract for the app terminal/session

1. **Carousel** (`prices.ts`): add `updated_at` to the `window_prices` `.select(...)`. Before
   using a row, check `Date.now() - Date.parse(row.updated_at) < CAROUSEL_FRESHNESS_MS`
   (suggest starting at 2h30m — daytime cadence + a safety margin). A stale row should either be
   hidden from that slide or shown with an explicit "цена от HH:MM" / relative-age badge, product
   to decide which.
2. **Roulette list** (`dailyOriginCheapest.ts`): same check on `source_updated_at` before
   surfacing a pool row's price. Membership/rank must NOT change because of staleness — only the
   price display/confidence.
3. **Roulette reveal** (`refreshDailyCheapestPrice` + `HeaderRoulettePanel.tsx`): this is the one
   that matters most — it's the "confirm before commit" step. Add an explicit age check on
   `row.updated_at`; if stale, do not treat it as confirmed — return a distinct "could not
   confirm a fresh price" outcome distinguishable from today's plain `null`, and have the caller
   surface that instead of silently proceeding with an old price.
4. Suggested single freshness constant shared by all three, e.g. `PRICE_FRESHNESS_MS` exported
   from one place in `src/lib/`, defaulting to something comfortably above the pilot's own
   2-hour daytime cadence (do not set it at 30 minutes — that would make daytime and night
   perpetually "stale" by design, which is a UX regression on its own).

## Until then

- Keep `PRIORITY_MARKET_SCHEDULE` unset (or any value other than `pilot`) in every environment.
  The ETL side defaults to exactly today's uniform 30-minute cadence with zero behavior change.
- `OFF_CYCLE_MAIN_MINUTES` (the separate off-cycle MAIN-advance mechanism in this same PR) has no
  app-side dependency and is independently safe to pilot — it never changes what price data looks
  like to a client, only how fast MAIN's background catalogue refresh catches up.
