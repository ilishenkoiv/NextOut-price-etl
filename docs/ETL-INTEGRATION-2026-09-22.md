# ETL integration package — 2026-09-22

Status: local package only. Nothing in this document authorizes a production run, migration,
workflow toggle, GitHub variable/secret change, commit or push.

## Target ownership after the future switch

| Duty | Published legacy owner (preserved) | New coordinated owner | Mutual exclusion |
|---|---|---|---|
| MAIN direct + any, 182 IATA / 184 places / 6 months | `fetch-prices.yml` | coordinator `main` adapter | `COLLECTION_MODE` + shared lock |
| Cheapest membership/rank/order | `snapshot-daily-origin-cheapest.yml` after MAIN | `nightly-cheapest-selection.yml`, once per Berlin day at 03:30 plus guarded catch-up | legacy job requires non-coordinated; new job requires coordinated; `observed_on` guard |
| Exact cheapest-ticket refresh | legacy snapshot cron `7,37` | coordinator `priority` adapter, every 30-minute internal cycle | legacy job requires non-coordinated; standalone new workflow is manual fallback only and refuses coordinated mode |
| Weekend/holiday full discovery | `fetch-window-prices.yml` | coordinator `tail` (daily durable discovery plan) | mode gate + shared lock |
| Weekend/holiday exact consumer-set refresh | legacy full sweep (not separated) | coordinator `priority`, durable daily `windowrefresh-*` plan and full resumable cursor | one coordinator lease/provider |
| Exact user feedback audit | `check-flight-price-feedback.yml`, legacy night gate | coordinator `priority`, up to 10 leased claims per 30-minute cycle | mode gate; claim token + coordinator fence |
| FAST/watch exact windows | legacy window workflow | coordinator `fast`, established two-hour job across four 30-minute cycles | coordinator lease/provider |
| Retention/metrics/plan cleanup | separate legacy maintenance workflows | coordinator `maintenance` after priority/MAIN/TAIL | existing mode/idle gates remain until PO switch decision |

All Travelpayouts work in coordinated mode uses one `CollectionProvider`, one `TP_TOKEN`, one
fenced coordinator lease and strictly sequential calls. The nightly selection performs no provider
requests. Legacy workflow files remain present and their published schedules were not switched by
this package.

## Consumer-compatible window set

Read-only trace of sibling app `NextOut-eas-build-bd4ec06` found:

- `src/lib/prices.ts` loads **all** `window_prices`, paginated by the five-column PK (source comment
  records 1,534 rows at the time it was written; this is not a current production readback);
- `breakWindows.ts` produces factual weekend/holiday windows with 10-day lead and four-month
  horizon; `breakSlides.ts` selects at most 15 displayed slides, but ranking depends on device-local
  wish/dream/never/vibes and is redone per window;
- therefore the server cannot truthfully derive a smaller universal top-N selected set. A fixture
  count (96 or 1,205) is test data, not a production fact.

The durable set is consequently every exact direct/any `window_prices` row matching the app's
10-day lead, four-month horizon and `weekend|holiday` kinds. Its identity is
`window-consumer:<Berlin-day>:<sha256 membership prefix>`. Source changes cannot change membership
mid-pass. There is no `/48` or invented cap: each 30-minute scheduler cycle resumes the full cursor;
unfinished work carries across missed cycles/midnight, expired rows are skipped, and completion
records full-cycle duration plus oldest pre-refresh age. A 30-minute trigger is not a 30-minute
freshness guarantee: target age is ≤30 minutes only when the measured full pass fits; otherwise
`fullCycleMs`, cursor lag and per-ticket age report the overload.

FAST/TAIL query the exact PK's `updated_at` and skip provider work when priority refreshed it in the
last 30 minutes. They retain missing-row discovery and watch/full-discovery duties without an
accidental duplicate exact-ticket request.

## Nominal budget and hard conflict

The 30-minute cycle reserves 2 min priority, 2 FAST, 23 MAIN, 1 TAIL, 1 maintenance and 1 reserve.
A 235-minute session starting at cron minute 07 contains **181 nominal MAIN minutes**, inside the
180–210 target, before priority overrun. Due priority work pre-empts every lower phase; lag is stored
as `priority.checkpoint.lagMs` and is not disguised as cadence success.

Maximum configured cheapest pool is 22 canonical origins × 10 = 220 tickets, plus up to 10 audit
claims and the uncapped consumer window set. Priority may use at most five active minutes per
30-minute cycle; after that MAIN proceeds and the final two minutes are reserved for TAIL and
maintenance. Old priority cursors roll forward instead of restarting.

MAIN now performs four mandatory calls per cell (two return windows × direct/any), plus an optional
positive-only calendar call after two confirmed empties and explicit retry/backoff overhead. At
0.5 s/request +0.1 s DB, a no-fallback cell projects to 2.1 s; at the 8 s timeout it is 32.1 s.
The former 24 cells/min model is therefore only a scenario, not a measured post-change fact.
Real-adapter fake-clock tests cover normal 250 ms and slow 8 s responses, DB writes, boundary yield,
priority overrun, cursor rollover and lower-phase progress. Production must measure the actual rate.

## Transfer onto current main

1. Fetched refs read-only on 2026-09-22: `origin/main` is
   `95556f70fdb42b0e3c16b3f8dece2f6e21a042b9`; WIP HEAD `cec4ed1` is its direct ancestor.
   PR #5 changes `collection-planning`, Expansion tranche adapter/tests and the coordinator
   `GUARANTEE_DAILY_MAIN` wiring. The latter is explicitly carried in this package.
2. Start an isolated tree at `origin/main` and apply the exact manifest in
   `docs/ETL-INTEGRATION-FILES-2026-09-22.txt`,
   resolving `collection-schedule.mjs`, `collection-adapters.mjs`, `run-collection.mjs` and their
   tests semantically. Do not wholesale choose either side.
3. Confirm PR #5 production fixes remain, then run profile tests, `npm.cmd test`, and
   `git diff --check` in the integration worktree.
4. After PO acceptance only, apply in order: scheduler migrations `20260916140000` and
   `20260916141000` if absent, then `20260922120000_route_price_health.sql`,
   `20260922121500_collection_main_variants.sql`, and
   `20260922122500_daily_cheapest_selection.sql`. Execute readbacks. SQL execution is currently
   **UNVERIFIED** because this environment has no psql/Docker/Podman; use
   `scripts/verify-etl-migrations.sql` against a disposable migrated DB before any production step.
5. Run `collection-coordinator.yml` manually with `validate_only=true`. This is read-only and must
   confirm the private bucket, route-health schema and RPC metadata.
6. Record legacy baselines and queue depth. In one coordinated cutover, set the existing mode gate
   only after the old run is completed and its lease is gone. Do not enable a standalone refresh.
7. Observe at least 24 hours before acceptance; a local simulation does not prove full-pass time.

Required settings at cutover: existing `TP_TOKEN`, `SUPABASE_SERVICE_KEY`, `SUPABASE_URL`,
`COLLECTION_MODE=coordinated`, approved `EXPANSION_WAVE=43`, and the separately approved
`SNAPSHOT_EXPANSION_WAVE`. No new secret is introduced. `EXPANSION_TRANCHE_DESTS` is optional and
bounded to 0–12. Published PR #5 wiring keeps `GUARANTEE_DAILY_MAIN` false unless PO sets it; the
new static slot allocation does not depend on that optional tail-yield.

## Rollback

1. Stop/allow the current coordinator run to release its lease; verify no active provider request.
2. Restore the legacy mode gate as one atomic ownership change. Do not run legacy and coordinator
   together and do not manually dispatch the fallback refresh while coordinated.
3. The additive `route_price_health` table may remain. To remove it later, roll code back first,
   then use the rename/drop instructions embedded in the migration. Existing catalog, prices,
   offers and `window_prices` are not deleted by rollback.
4. If only budget behavior is faulty, set `GUARANTEE_DAILY_MAIN=false`; priority ownership and
   fencing remain unchanged.

## Production acceptance metrics

- `priorityLagMs`: p50 ≤5 min, p95 ≤10 min; any ≥30 min has an external-delay annotation.
- Per cycle: audit claims ≤10, roulette cursor/request count and consumer-window cursor/set ID;
  no duplicate exact key between priority and FAST/TAIL. Report `fullCycleMs`, oldest ticket age and
  missed cycles; do not infer freshness from cron alone.
- Exactly one cheapest `observed_on` row-set per Berlin day across spring/fall DST and catch-up.
- MAIN active time 180–210 min per healthy 235-minute session after subtracting measured priority
  overrun; full logical pass ≤24 h (target ~12 h) verified from production completion timestamps.
- FAST and TAIL cursors continue across runner handover/day change; no full window sweep is started
  by priority refresh.
- Provider 429/network/server refusals, retry delay and circuit-breaker events are counted; they do
  not create `dead` status. Lease-loss write attempts = 0.
- Every `dead` transition has a complete six-month confirmed-empty pass and age ≥30 days;
  approximately one seventh of dead routes is scheduled per pass; any confirmed price changes the
  route to active immediately. Expansion routes cannot transition before protection expires.
