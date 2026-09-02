# NextOut Price ETL

A standalone data-collection pipeline that gathers flight prices for the *NextOut* travel
app and writes them into a Supabase database. It contains no product logic — no ranking,
no scoring, no UI.

## Stack

| Concern | Tool |
| --- | --- |
| Runtime | Node.js 22, ES modules |
| Source API | External flight-data provider |
| Storage | Supabase (Postgres) via `@supabase/supabase-js` |
| Scheduling | GitHub Actions |
| Tests | `node --test` |

## Roulette price freshness

`.github/workflows/snapshot-daily-origin-cheapest.yml` revalidates only the exact tickets in the
current roulette every two hours, then builds a new roulette snapshot. A confirmed fare updates the
cached offer; a successful empty response removes only that exact unavailable offer; an HTTP,
network or malformed-response failure preserves the previous value. If the main `Twice-daily price
fetch` is queued or running, the two-hour refresh skips its work. A successful main sweep triggers
the roulette rebuild itself, so the lightweight checker never competes with the main collector.

## Storage retention

`.github/workflows/cleanup-price-storage.yml` runs at 00:02 Europe/Berlin on the first day of each
quarter. It keeps canonical `price-snapshots` objects for 365 days and
`window_price_progress` resume markers for 35 days. Unknown Storage objects are never deleted.
The workflow uses the shared night-maintenance lock and skips all work outside the protected night
window or while the main price collector, carousel collector, or roulette refresh is active/queued.
Manual runs default to `dry-run`; scheduled quarterly runs use `apply`.

## Weekly climate normals

`npm run weather:fetch-weekly` downloads resumable 1991–2020 ERA5-Land point time series for all
139 destinations. Missing island land cells use the matching global ERA5 time-series product;
coastal points may use the nearest verified 0.1° land cell. Raw downloads and daily intermediates
stay ignored locally.

`npm run weather:build-weekly` produces the tracked compact
`data/weather-weekly-normals.json` and the generated production migration only at full coverage.
`npm run weather:verify-weekly` checks 139 destinations × 53 ISO weeks, numeric ranges, source
resolution and JSON/SQL parity. With `NEXTOUT_APP_CONFIG` pointing to the app's public config,
`npm run weather:verify-production` paginates the public Supabase table and requires an exact
7,367-row match with the verified local payload.

The product is derived from ERA5-Land (DOI `10.24381/cds.e2161bac`) and, for individual islands,
ERA5 hourly time-series on single levels (DOI `10.24381/1cf1ad76`). Contains modified Copernicus
Climate Change Service information [2026]. Neither the European Commission nor ECMWF is
responsible for any use that may be made of the Copernicus information or data it contains.

## Destination events

`npm run fetch-events` discovers exact-date Wikidata records within 35 km of all 139 destination
centres for the rolling next six months, then keeps only the strict editorial allowlist of
travel-worthy celebrations (for example Oktoberfest, Christmas markets, carnivals, New Year and
comparable traditional festivals), plus an explicit named allowlist of world-scale sport and
exhibitions such as the Olympics, FIFA World Cup, Formula 1, World Expo, Gamescom or Venice
Biennale. Generic conferences, ordinary matches, regional fairs and business exhibitions never
enter the owner queue. `DRY_RUN=1` and optional `EVENT_IATAS=MUC,CGN` perform a
supervised discovery without writes. Structured Wikidata data is CC0; approval still requires an
official-source check for the concrete edition.

The product source of truth is the small explicit `src/data/destination-holidays.js` manifest.
Every row is one concrete edition with dates already checked on an official organiser/city page;
dates are never rolled into another year automatically. Wikidata is only a secondary discovery
helper. Both manifest rows and discovered rows still enter production as candidates and remain
invisible to the app until owner approval freezes the reviewed fingerprint.

Apply `migrations/20260828200000_destination_events.sql` manually before the first write. Missing
table is a safe no-op. Monthly discovery creates `candidate` rows; the app can read only active,
owner-approved rows whose source fingerprint still matches the reviewed fingerprint. Approval is
performed through the service-role-only `review_destination_event` RPC used by the local dashboard.

## License

Proprietary. All rights reserved — see [LICENSE](./LICENSE).

You may read this repository. You may not use, copy, modify or distribute it without
written permission.

---

© 2026 Ilia Ilishenko. All rights reserved.
