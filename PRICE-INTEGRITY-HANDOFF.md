# Price integrity — rollout 10.09.2026

## Prebuild repair 10.09 — local, not published

Run 34467238874 at 9769114 failed before any jobs. The six far-month job conditions referenced
the unavailable job-level `env` context. `collection_config` now exports the tracked false
switch through job outputs; far collectors and watchdog use `needs`. A failed config job is
reported by watchdog. Schedules, six-month horizon, sequential collection and concurrency stay
unchanged. Tests: 96/96 PASS; YAML parsing and job dependency/context checks PASS.
Publish this repair only with owner authorization; successful collection and validated coverage
still require production readback. No collector, SQL or deployment was executed in this repair.

Published to GitHub `main`: `9769114 Limit price collection to six months`.
The country-watch schema was manually applied by the owner before this publish. Both scheduled
price sweeps now collect months 1–6 only, across all 22 origins and the whole destination network;
the preserved month 7–12 jobs are disabled by `ENABLE_FAR_MONTHS=false`. Baseline reads retry
transient Supabase/Cloudflare failures up to four attempts. Await the first validated scheduled
run before calling the data rollout complete.

End-of-day: country priority now expands watch_scope/country_code using the public catalogue.
The app repository's `20260909190000_country_price_watches.sql` was applied manually by the owner
on 10.09 before this ETL deployment.
Both main and window planners are covered;93 tests passed. Save this branch to origin only,
do not merge main or execute collectors tonight. Full coordinated rollout is in the app's
docs/owner/MORNING-2026-09-10.md. No production changes were executed while closing the day.

Base origin/main ab80088, branch codex/price-integrity-20260909; published to main as 9769114.
No post-publish collector run has been observed yet.
Changes: quote-integrity.mjs used by v3/calendar before min, one_way=false, monthly sample_offer
preserved by provenance. Default daily main dead plan and window auto plan include selected
LGK/KBV/HKT/DPS/MLE/SEZ and active watch routes. Manual top-only window mode unchanged.
Reads only origin/destination identifiers from existing private watch-rules table; no tokens logged.
Tests: npm test92/92, both actual parsing functions tested on one-way389 +roundtrip710.

Before release: measure added requests, confirm service-role grants/readback, merge branch inventory,
deploy only with owner approval, run controlled pilot then full validated horizon. Do not deploy strict
client/server monthly guard before new price_source.round_trip_validated data exist.
Main app work is in ../../NextOut-eas-build-bd4ec06; detailed rollout doc in its docs/owner.
History retained;48h eligibility is implemented in app/server source, not a destructive data cleanup.
