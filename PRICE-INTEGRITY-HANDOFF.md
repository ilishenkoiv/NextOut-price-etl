## 16.09 sequential collection — published, first wave configured

Publication confirmed: main3ffb408. Read-only validation35083373280 succeeded:
8RPCs, private bucket and price schemas confirmed, providerRequests0, no lease claim.
Owner's SQL step is closed. GitHub variables read back: coordinated / wave10 /
snapshot-wave0. Old main35082444832 continues; old queued carousel35061613784 is
confirmed cancelled. Published3ffb408 refuses collection while another workflow
is active. First new price session awaits an eligible scheduled run after the
old main finishes; validation success does not claim price collection success.
The optional drain-trigger patch was rejected and is NOT published. Its three
code files were restored to3ffb408 after preserving a patch in the app's .work.

### Earlier preparation and approval history — superseded by the status above

Owner confirmed manual application of ENABLE-SEQUENTIAL-COLLECTION.sql on16.09.
Read-only GitHub-backed schema validation is prepared but needs this code published.
Direct publication to origin/main was rejected by automatic approval review:
explicit authorization for this 44-file production publication target is required.
No push or mode switch occurred. At10:02UTC old main35082444832 is still in month1,
and old carousel35061613784 is queued. Do not run the new collector alongside them.

Prepared a resumable main/window/fast/audit/roulette worker, shared queued workflow
lock, private fenced state and atomic cell writes. All 43 airport targets are
available behind 0/10/21/43 rollout waves; app snapshot exposure is independently
gated and remains at zero new targets. Source state is still based on production31b1077.
No production SQL, workflow dispatch, mode-variable change or live provider sweep
has been executed. Photos and owner weather actions are explicitly deferred to the end.
Owner SQL package: ../../NextOut-eas-build-bd4ec06/supabase/manual/ENABLE-SEQUENTIAL-COLLECTION.sql.
Apply before enabling coordinated mode. Detailed operator plan lives in the app's
docs/owner/COLLECTION-IMPLEMENTATION-2026-09-16.md. The watch-country GB/NL change
already present in this worktree is preserved.

## 13.09 local retry update — not published

Bounded 20s database requests; outer retry disables nested SDK retries, preserves Retry-After from PostgREST errors, adds jitter and redacted status/recovery logs. Wired to window collector and roulette refresh. 103 tests PASS, including real PostgREST builder with mocked HTTP 504. No production writes or publish. Dashboard C: recovery classifier + minute polling (five-minute cache), 16 tests PASS. D: transfer awaits explicit permission after auto-review rejection.

# Price integrity — rollout 10.09.2026

## Repair published 10.09

Owner confirmed continuation after the explicit push request. Commit dfa7a91080fd72a9826d20d10a9cb32b76e2f2fc
was pushed to origin/main and verified with ls-remote. The old collector run34462645694
was still in_progress at ab80088; no successful run of the repaired version is confirmed yet.
No manual collector dispatch or database changes were executed. Earlier local-only notes below are history.


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
