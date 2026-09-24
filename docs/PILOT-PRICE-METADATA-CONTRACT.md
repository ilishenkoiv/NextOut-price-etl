# Pilot/price-freshness metadata contract — app handoff

**Status: implemented and tested server-side in this PR, at commit noted in the PR description.
NOT activated — `PRIORITY_MARKET_SCHEDULE` remains unset in every environment. This contract
publishing exists so the app CAN read real state once it is enabled; publishing it does not itself
turn the pilot on.**

This satisfies docs/owner/COLLECTION-FINISH-PLAN-2026-09-24.md gate 3 ("Prepare and verify the
server pilot metadata ... before enabling `PRIORITY_MARKET_SCHEDULE=pilot`") and
docs/owner/TICKET-PRICE-POLICY-2026-09-24.md's 120-minute `current` ceiling.

## What it is

One public, read-only Supabase table, `public.collection_pilot_state`, holding exactly one row
(`scope='global'`). It is the single source of truth for **both** carousel and roulette — there is
no per-origin/per-market variant, because both fields below are global policy/ops values, never
origin-specific (see the migration file's header comment for why a single row is the correct
identity, not a per-origin table).

## Exact fields

| Column | Type | Meaning |
|---|---|---|
| `scope` | `text`, primary key, always `'global'` | Row identity. The app always reads the single row with `scope='global'` (or an unfiltered `select().limit(1)` — there is only ever one row). |
| `pilot_active` | `boolean` | Whether `PRIORITY_MARKET_SCHEDULE` is **actually** set to the literal string `'pilot'` in the currently running server process, re-evaluated on every publish. `false` for unset, empty, or any other value (see `pilot-price-metadata.test.mjs` for the exact non-'pilot' cases covered). Turning the repo Variable off makes this `false` again on the very next publish — no separate rollback code path exists or is needed. |
| `price_freshness_ms` | `integer` | The approved maximum age (in milliseconds) for a price to be considered `current`, per docs/owner/TICKET-PRICE-POLICY-2026-09-24.md. Currently always `7200000` (120 minutes) regardless of `pilot_active` — the ceiling is a fixed product policy value, not derived from collection cadence, and is identical whether the pilot or the legacy schedule is running. A DB `check` constraint additionally enforces this can never be inserted above 7,200,000 even if a future writer bug tried. |
| `updated_at` | `timestamptz` | When this row was last (re)published by the coordinator. |

## Update timing

Published by `scripts/pilot-price-metadata.mjs`'s `publishPilotState()`, called from
`scripts/run-collection.mjs`'s `main()`:
- Once per **regular due session** (every ~30 minutes at worst under the current schedule — see
  `SLOTS`/`CYCLE_MS` in `collection-schedule.mjs`), right before daily selection runs.
- Once per **actual off-cycle MAIN-advance attempt** (only when `OFF_CYCLE_MAIN_MINUTES>0` and
  there is real runway — never on the immediate 5-minute `collection_not_due` no-op exit, which
  stays exactly as cheap as it is today).

Both call sites run under the coordinator's own single collection lease/fence
(`CollectionStore`) — this is not a second/independent writer. Because the two fields almost never
change (only when a human toggles the repo Variable or the owner revises the approved ceiling),
publishing on every 5-minute heartbeat was deliberately avoided as unnecessary write load; the
due-session cadence already keeps staleness well inside the 120-minute ceiling this same contract
publishes.

## Anon read permissions

- `anon` (the app's public API key) has `SELECT` only, via an explicit RLS policy
  (`"anon read collection_pilot_state"`, `using (true)`) and an explicit `grant select`.
- `anon`/`authenticated`/`public` are explicitly `revoke`d `INSERT`/`UPDATE`/`DELETE`; only
  `service_role` (which the app never uses) can write, and only through `publishPilotState()`.
- No secret, token, or internal-only field exists on this table — it is safe to expose in full to
  an anonymous client.

## Exact handoff for the app window

1. Read `public.collection_pilot_state` with the existing anon Supabase client:
   `supabase.from('collection_pilot_state').select('pilot_active,price_freshness_ms,updated_at').eq('scope','global').maybeSingle()`.
2. Treat a **missing row** (table not yet migrated, or `data === null`) identically to
   `{ pilot_active: false, price_freshness_ms: 7_200_000 }` — the legacy, always-safe state. Do
   not block or error the UI on a missing row; this table is additive.
3. Use `price_freshness_ms` (not a hardcoded app-side constant) as the single ceiling for the
   `current` vs. stale decision across carousel and roulette, per
   docs/owner/TICKET-PRICE-POLICY-2026-09-24.md — this replaces the app repo's own ad-hoc
   `CAROUSEL_FRESHNESS_MS` suggestion in `docs/PILOT-MARKET-SCHEDULE-APP-CONTRACT.md` with a
   single server-declared value both surfaces share.
4. `pilot_active` is informational for the app's own internal logic (e.g., whether to expect
   longer legitimate gaps between refreshes); it must **never** be shown to the end user — the
   owner policy forbids any user-visible check-time/staleness label regardless of pilot state.

**This server change alone does not activate anything in the app.** App PR #1's own switch (gated
on `PRICE_PILOT_MODE_ENABLED` per that PR's own report) and the remaining freshness-check call
sites documented in `docs/PILOT-MARKET-SCHEDULE-APP-CONTRACT.md` (carousel `prices.ts`, roulette
`dailyOriginCheapest.ts`/`HeaderRoulettePanel.tsx`) are separate, still-outstanding app-side work.
Reading this new table does not by itself add any freshness check where none exists today.

## Rollback

Additive-only; safe to roll back independently of any other PR #24 work at any time:

```sql
drop policy if exists "anon read collection_pilot_state" on public.collection_pilot_state;
drop table if exists public.collection_pilot_state;
notify pgrst, 'reload schema';
```

Then revert the two `publishPilotState` call sites and the import in `scripts/run-collection.mjs`,
and delete `scripts/pilot-price-metadata.mjs` / `scripts/pilot-price-metadata.test.mjs`. No other
PR #24 mechanism (MAIN capacity work, roulette/carousel schedule parity) depends on this table.
