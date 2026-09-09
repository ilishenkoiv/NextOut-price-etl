# Price integrity — local work09.09.2026

End-of-day: country priority now expands watch_scope/country_code using the public catalogue.
Apply the app repository's 20260909190000_country_price_watches.sql BEFORE deploying this ETL.
Both main and window planners are covered;93 tests passed. Save this branch to origin only,
do not merge main or execute collectors tonight. Full coordinated rollout is in the app's
docs/owner/MORNING-2026-09-10.md. No production changes were executed while closing the day.

Base origin/main ab80088, branch codex/price-integrity-20260909. No push/deploy/workflow run.
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
