# NextOut Price ETL

A small, standalone **ETL pipeline** that collects real flight prices from the
[Travelpayouts](https://www.travelpayouts.com/) data API and writes them into a
[Supabase](https://supabase.com/) (Postgres) database on a nightly schedule, fully
automated with **GitHub Actions**.

## Hotel price segments

Hotel price segments are maintained as static curated data in Supabase
(`hotels_segments`), refreshed manually ~twice a year. The Hotellook API integration
was removed (endpoints discontinued upstream). This pipeline collects **flight prices
only**.

It is the data-collection half of the *NextOut* travel app, extracted into its own
repository. It contains **no product logic** — no ranking, no scoring, no UI — just the
pipeline: **Travelpayouts API → Supabase**.

## Why it exists

The app must never call Travelpayouts directly: the API token can't ship in a client and
the endpoint is rate-limited (~60 req/min). So prices are collected **server-side**, once
a night, into a database the app reads with a public read-only key.

## Stack

| Concern | Tool |
| --- | --- |
| Runtime | Node.js 22 (native `fetch` + `WebSocket`), ES modules |
| Source API | Travelpayouts / Aviasales v3 `prices_for_dates` |
| Storage | Supabase (Postgres) via `@supabase/supabase-js` (REST upsert) |
| Scheduling | GitHub Actions (`cron`, twice daily) |
| Deps | `@supabase/supabase-js`, `ws` |

## How it works

1. **Plan** — for each of 16 departure airports (12 hubs + 4 low-cost bases), build the
   list of destinations to query. Hubs query every destination; low-cost bases query
   only their curated route map.
2. **Collect** — one request per route-month over a 6-month horizon. Near destinations
   query direct flights, long-haul query cheapest-with-stops. A ≥1100 ms pause between
   every call keeps it under the rate limit.
3. **Load** — rows are buffered and `upsert`ed into Supabase in batches, flushed
   periodically so a multi-hour run persists partial progress. Failures are logged and
   never crash the run; the script ends with a written/errors summary.

## Data schema

```
prices   ( origin text, dest text, month text 'YYYY-MM',
           direct int null, any_stops int null, updated_at timestamptz )
           primary key (origin, dest, month)
```

(`hotels_segments` is a static curated table maintained manually — see
[Hotel price segments](#hotel-price-segments) — and is not written by this pipeline.)

Reference data lives in `src/data/`:
- `origins.js` — departure airports (hubs + low-cost bases).
- `routes.js` — curated origin→destination route map for low-cost bases.
- `destinations.js` — destination IATA codes with `stops` (routing) and `bestMonths`
  (seasonality). Product scoring lives in the private app repo and is not included here.

## Configuration

All secrets come from environment variables — **nothing is hardcoded or committed**:

| Var | Required | Notes |
| --- | --- | --- |
| `TP_TOKEN` | yes | Travelpayouts API token. **Secret.** |
| `SUPABASE_SERVICE_KEY` | yes | Supabase service-role key (writes past RLS). **Secret.** |
| `SUPABASE_URL` | no | Project URL (public, not a secret). |
| `TP_PAUSE_MS` | no | Override the inter-request pause (default 1100 ms). |

In GitHub Actions these are read from repository **Secrets**.

## Run locally

```bash
npm install

# bash
TP_TOKEN=... SUPABASE_SERVICE_KEY=... SUPABASE_URL=https://<project>.supabase.co \
  node scripts/fetch-prices.mjs

# PowerShell
$env:TP_TOKEN="..."; $env:SUPABASE_SERVICE_KEY="..."; node scripts/fetch-prices.mjs
```

A full run makes ~1000+ API calls and takes a couple of hours; set `TP_PAUSE_MS` lower
only for small test runs, never against the live API at scale.

## License

MIT
