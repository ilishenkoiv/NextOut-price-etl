# NextOut Price ETL

A small, standalone **ETL pipeline** that collects real flight prices from the
[Travelpayouts](https://www.travelpayouts.com/) data API and writes them into a
[Supabase](https://supabase.com/) (Postgres) database **twice daily**, fully
automated with **GitHub Actions**.

It is the data-collection half of the *NextOut* travel app, extracted into its own
repository. It contains **no product logic** — no ranking, no scoring, no UI — just the
pipeline: **Travelpayouts API → Supabase**.

## Why it exists

The app must never call Travelpayouts directly: the API token can't ship in a client and
the endpoint is rate-limited (~60 req/min). So prices are collected **server-side**, twice
daily, into a database the app reads.

## Stack

| Concern | Tool |
| --- | --- |
| Runtime | Node.js 22 (native `fetch` + `WebSocket`), ES modules |
| Source API | Travelpayouts / Aviasales v3 `prices_for_dates` |
| Storage | Supabase (Postgres) via `@supabase/supabase-js` (REST upsert / insert / delete) |
| Scheduling | GitHub Actions (`cron`, twice daily) |
| Deps | `@supabase/supabase-js`, `ws` — plus `sharp` as a devDependency for the photo scripts |

## Schedule

`.github/workflows/fetch-prices.yml` runs **twice daily**. GitHub Actions cron is UTC and
does not follow the CET/CEST switch; the Berlin times below assume CEST (summer, UTC+2)
and shift one hour earlier in winter.

| Cron (UTC) | Berlin (CEST) | What it collects |
| --- | --- | --- |
| `0 23 * * *` | 01:00 | full 12-month sweep — job `near` (months 1–6), then job `far` (months 7–12) |
| `0 10 * * *` | 12:00 | near months 1–6 only |

Near months are therefore refreshed twice daily, far months once daily on the night run.
The two jobs never collect in parallel: `far` declares `needs: near`, and a workflow-level
`concurrency` group (`cancel-in-progress: false`) makes a new run wait for an in-progress
one instead of doubling the request rate.

Manual runs go through `workflow_dispatch` with a `scope` input: `both` (default), `near`
or `far`.

## How it works

1. **Plan** — for each of the **20 departure airports** in `src/data/origins.js`
   (12 hubs + 8 low-cost bases), build the list of destinations to query: all **132
   destinations** from `src/data/destinations.js`, minus the origin itself where it is
   also a destination. That is **2637 route-pairs** — hubs and low-cost bases alike query
   the full network.
2. **Collect** — one request per route-month. A single invocation collects 6 consecutive
   months by default, and the night run chains two of them for a full **12-month horizon**
   (see [Schedule](#schedule)): **15 822 requests** per 6-month job, **31 644** for the
   full sweep. Near destinations (`stops: 0`, 76 of the 132) query direct flights,
   long-haul (`stops: 1`, 56 of them) query cheapest-with-stops. A ≥1100 ms pause between
   every call keeps it under the rate limit.
3. **Load** — rows are buffered and written to Supabase in batches (`upsert` for `prices`
   and `offers`, `insert` for `price_history`), flushed periodically so a multi-hour run
   persists partial progress. Request and write failures are logged and never crash the
   run; the script ends with a written/errors summary. The one fatal case is the baseline
   read at startup: if the current contents of `prices` cannot be loaded, the run aborts
   rather than log every route-month as changed.

## Data schema

`scripts/fetch-prices.mjs` fills **three tables from the same API responses**.

### `prices` — cheapest price per route-month

The table the app reads today. Exactly one row per route-month; every run overwrites the
previous value.

| Column | Written as | Notes |
| --- | --- | --- |
| `origin` | IATA text | departure airport |
| `dest` | IATA text | destination airport |
| `month` | text `'YYYY-MM'` | the requested departure month |
| `direct` | rounded integer or `null` | cheapest non-stop fare in EUR; filled only for `stops: 0` destinations, `null` otherwise |
| `any_stops` | rounded integer or `null` | cheapest fare with any number of stops in EUR; filled only for `stops: 1` destinations, `null` otherwise |
| `updated_at` | timestamptz (ISO string) | set by the collector on every write |

Upsert conflict target — and therefore the unique key — is **(origin, dest, month)**.

Exactly one of `direct` / `any_stops` carries a value per row: the collector makes a single
request per route-month, direct or any-stops depending on the destination's curated `stops`,
and writes `null` into the other column.

### `offers` — every kept individual offer

Each API item keeps its own dates, price, transfers and airline, so the app knows *which
days* are cheap instead of only the month minimum.

| Column | Written as | Notes |
| --- | --- | --- |
| `origin` | IATA text | |
| `dest` | IATA text | |
| `month` | text `'YYYY-MM'` | the **requested** month, not the offer's departure month (they can differ by a day at a month boundary) |
| `flight_type` | text | `'direct'` or `'any'` |
| `departure_at` | date-only `'YYYY-MM-DD'` | sliced from the API string, never parsed through `Date` |
| `return_at` | date-only `'YYYY-MM-DD'` or `null` | `null` for a one-way offer |
| `nights` | integer or `null` | whole nights between departure and return; `null` when there is no return date |
| `price` | rounded integer | EUR |
| `transfers` | integer | `0` when the API omits it |
| `airline` | text or `null` | |
| `updated_at` | timestamptz (ISO string) | |
| `in_cheap_pool` | `boolean not null default false` | migration `0001`; combo selection, see below |
| `target_nights` | `smallint`, `null` when unset | migration `0001`; combo selection, see below |

Primary key — also the upsert conflict target —
**(origin, dest, month, flight_type, departure_at, return_at)**.

`offers` is a per-run **snapshot**, not a log: rows are upserted on the primary key, then
rows older than the start of the run are deleted for the route-months that actually
answered, so a failed month keeps its previous offers instead of being wiped.

**Combo selection** — from the full response (`limit=500`) the collector keeps, per
route-month + `flight_type`:

- **(a)** the 10 cheapest offers of any length → `in_cheap_pool = true`;
- **(b)** the cheapest offer within ±1 night of each target duration → `target_nights` =
  that target.

The target set depends on the great-circle distance (haversine over `src/data/coords.js`)
and the destination's curated `stops`:

| Distance | `stops` | Target nights |
| --- | --- | --- |
| < 1500 km | any | 3 / 5 / 7 / 10 / 14 |
| 1500–4000 km | any | 5 / 7 / 10 / 14 |
| > 4000 km | 0 | 5 / 7 / 10 / 14 |
| > 4000 km | 1 | 7 / 10 / 14 |

One offer may carry both tags and is never duplicated. Where a target has no offer within
±1 night, no row is created for it.

### `price_history` — append-only log of price changes

`prices` upserts on (origin, dest, month), so each run clobbers the previous value; this
table keeps the time series. Rows are **inserted**, never upserted or updated.

| Column | Written as | Notes |
| --- | --- | --- |
| `origin` | IATA text | |
| `dest` | IATA text | |
| `month` | text `'YYYY-MM'` | |
| `direct` | rounded integer or `null` | same value as written to `prices` |
| `any_stops` | rounded integer or `null` | same value as written to `prices` |
| `observed_at` | timestamptz | not sent by the collector — filled by the column default (`now()`) at insert time |

A row is written **only** when this run's `direct`/`any_stops` differ from what `prices`
currently holds (or the route-month is new) **and** at least one of the two has a price —
a route that returned nothing is not logged. Recording only the ~10–20 % that change per
run is what keeps the table inside Supabase's storage cap.

### Tables created by migrations but not written by this pipeline

- **`flight_estimates`** (`migrations/0002_flight_estimates.sql`) — curated "from €X"
  fallbacks for destinations whose Travelpayouts cache is empty or nearly empty.
  `iata text primary key`, `from_price_eur integer not null check (from_price_eur > 0)`,
  `note text`, `updated_at timestamptz not null default now()`. RLS on, `anon` may select.
  Seeded by the migration and refreshed manually (~2×/year).
- **`weather_climate`** (`migrations/0003_weather_climate.sql`) — 30-year climate normals
  per destination × month. `iata text not null`, `month smallint not null check (month
  between 1 and 12)`, `avg_tmax numeric(4,1) not null`, `rain_days numeric(4,1) not null`,
  `avg_sun_h numeric(4,1) not null`, `precip_mm integer not null`, `updated_at timestamptz
  not null default now()`, `primary key (iata, month)`. RLS on, `anon` may select. Built
  one-off from Open-Meteo by `scripts/build-climate.mjs` and seeded by the migration.

### Reference data

Reference data lives in `src/data/`:

- `origins.js` — departure airports, grouped into `HUB_AIRPORTS` and `LOWCOST_AIRPORTS`.
  The grouping is **informational only**: both groups query the full destination network.
- `destinations.js` — destination IATA codes with `stops` (0 = query direct, 1 = query
  any-stops) and `bestMonths` (seasonality, informational). Product scoring lives in the
  private app repo and is not included here.
- `coords.js` — generated `iata → [lat, lng]` for origins and destinations; the distance
  behind the combo target set.
- `routes.js` — hand-curated low-cost route map. **Reference only — no longer read by the
  collector**, which now queries every destination from every origin.
- `cities.js`, `nearby-airports.js` — used by the photo-curation scripts and the app; not
  read by the price collector.

## Configuration

All secrets come from environment variables — **nothing is hardcoded or committed**:

| Var | Required | Notes |
| --- | --- | --- |
| `TP_TOKEN` | yes | Travelpayouts API token. **Secret.** |
| `SUPABASE_SERVICE_KEY` | yes | Supabase service-role key (writes past RLS). **Secret.** |
| `SUPABASE_URL` | no | Project URL (public, not a secret). Falls back to the project URL built into the script. |
| `TP_PAUSE_MS` | no | Override the inter-request pause (default 1100 ms). |
| `MONTH_START` | no | 1-based offset from the current month (default 1). The current, partly elapsed month is never collected. |
| `MONTH_COUNT` | no | How many consecutive months to collect (default 6). |

In GitHub Actions these are read from repository **Secrets**; the workflow sets
`MONTH_START` / `MONTH_COUNT` per job (`1`/`6` for near, `7`/`6` for far).

## Run locally

```bash
npm install

# bash
TP_TOKEN=... SUPABASE_SERVICE_KEY=... SUPABASE_URL=https://<project>.supabase.co \
  node scripts/fetch-prices.mjs

# PowerShell
$env:TP_TOKEN="..."; $env:SUPABASE_SERVICE_KEY="..."; node scripts/fetch-prices.mjs
```

With the defaults (6 months, 1100 ms pause) a run issues **15 822 API calls** and takes
**~4 h 50 min at minimum** — that is the enforced pause alone, and it is the same figure
the script prints as its ETA on startup. Collecting all 12 months means two runs: 31 644
calls, ~9 h 40 min. Set `TP_PAUSE_MS` lower only for small test runs, never against the
live API at scale.

---

© 2026 Ilia Ilishenko. All rights reserved.
