// Disposable-database proof runner for scripts/verify-roulette-pool-found-sync.sql.
//
// GAP THIS CLOSES: the review found PR #23's SQL suitable for a bounded rollout, but its claimed
// "4/4 transactional PGlite proof" could not be reproduced from a clean checkout — no PGlite
// dependency and no runnable harness were committed. This script is that harness, pinned to a
// committed PGlite devDependency (@electric-sql/pglite, package.json).
//
// SCOPE: `public.offers` predates this repo's migration history (0001_offers_combo_columns.sql
// only ALTERs it; grep across every tracked migration finds no `create table ... offers`, and
// `git log --all -- '*offers*'` has no creation commit either — it was bootstrapped manually in
// Supabase before migration tracking began). Faithfully replaying migrations from an empty
// database therefore requires ONE stub for that pre-existing base table. Every other object
// touched by collection_commit_roulette (public.daily_origin_cheapest_pool,
// public.collection_scheduler_state, public.roulette_pool_replacements,
// public.aviasales_market_for_origin) IS created by tracked migrations and is applied here
// VERBATIM from the real files — not reimplemented.
//
// To keep this the "smallest repeatable verification package" (per the owner's ask) rather than
// replaying the full, unrelated 26-migration history (destination photos, weather, window prices,
// storage metrics, flight-price-feedback audit trail — none of which collection_commit_roulette
// touches, and several of which assume additional pre-existing external objects of their own,
// e.g. Supabase's storage.* schema or a pre-existing public.is_dashboard_admin()), this harness
// applies the FULL text of every migration file that is a genuine dependency of
// collection_commit_roulette, and for the two files that also define unrelated functionality
// bundled in the same file, applies the exact verbatim substatements the roulette path needs
// (each one quoted with its source file:line below, so it can be diffed against the real file).
// Nothing here rewrites or reinterprets any statement.
//
// Usage: node scripts/pg-verify-roulette-pool-found-sync.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const migrationsDir = path.join(repoRoot, 'migrations');

const readMigration = (file) => readFileSync(path.join(migrationsDir, file), 'utf8');

const db = new PGlite();

async function exec(sql, label) {
  try {
    return await db.exec(sql);
  } catch (err) {
    throw new Error(`${label} failed: ${err.message}`);
  }
}

console.log('[harness] booting PGlite and creating supabase-like roles');
await exec(
  `do $$ begin
     if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
     if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
     if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
   end $$;`,
  'role bootstrap'
);

console.log('[harness] stubbing public.offers (the one pre-existing base table outside migrations/)');
await exec(
  `create table public.offers (
     origin text not null,
     dest text not null,
     month text not null,
     flight_type text not null,
     departure_at date not null,
     return_at date,
     nights smallint,
     price numeric,
     transfers smallint,
     airline text,
     updated_at timestamptz,
     primary key (origin, dest, month, flight_type, departure_at, return_at)
   );`,
  'stub public.offers'
);

console.log('[harness] applying migration 20260829120000_daily_origin_cheapest_pool.sql (verbatim, full file)');
await exec(readMigration('20260829120000_daily_origin_cheapest_pool.sql'), '20260829120000_daily_origin_cheapest_pool.sql');

console.log('[harness] applying price_source columns (verbatim lines from 20260903120000_flight_price_accuracy.sql:3-4,7)');
await exec(
  `alter table public.offers add column if not exists price_source jsonb;
   alter table public.daily_origin_cheapest_pool add column if not exists price_source jsonb;`,
  '20260903120000_flight_price_accuracy.sql (price_source excerpt)'
);

console.log('[harness] applying aviasales_market_for_origin + market columns (verbatim lines from 20260906120000_aviasales_market_provenance.sql:5-28,31,36,52-53,62-63)');
await exec(
  `create or replace function public.aviasales_market_for_origin(p_origin text)
   returns text
   language sql
   immutable
   strict
   set search_path = ''
   as $$
     select case upper(p_origin)
       when 'FRA' then 'de' when 'MUC' then 'de' when 'BER' then 'de'
       when 'DUS' then 'de' when 'HAM' then 'de' when 'STR' then 'de'
       when 'CGN' then 'de' when 'NUE' then 'de' when 'FMM' then 'de'
       when 'HHN' then 'de' when 'NRN' then 'de' when 'DRS' then 'de'
       when 'LEJ' then 'de'
       when 'VIE' then 'at' when 'SZG' then 'at'
       when 'ZRH' then 'ch' when 'GVA' then 'ch' when 'BSL' then 'ch'
       when 'BTS' then 'sk'
       when 'AMS' then 'nl' when 'EIN' then 'nl'
       when 'LHR' then 'gb'
       else null
     end
   $$;
   revoke all on function public.aviasales_market_for_origin(text) from public, anon, authenticated;
   grant execute on function public.aviasales_market_for_origin(text) to service_role;

   alter table public.offers add column if not exists market text;
   alter table public.daily_origin_cheapest_pool add column if not exists market text;
   alter table public.offers drop constraint if exists offers_market_check;
   alter table public.offers add constraint offers_market_check check (market is null or market ~ '^[a-z]{2}$');
   alter table public.daily_origin_cheapest_pool drop constraint if exists daily_origin_cheapest_pool_market_check;
   alter table public.daily_origin_cheapest_pool add constraint daily_origin_cheapest_pool_market_check check (market is null or market ~ '^[a-z]{2}$');`,
  '20260906120000_aviasales_market_provenance.sql (market excerpt)'
);

console.log('[harness] applying migration 20260916140000_collection_scheduler_state.sql (verbatim, full file)');
await exec(readMigration('20260916140000_collection_scheduler_state.sql'), '20260916140000_collection_scheduler_state.sql');

{
  const full = readMigration('20260916141000_collection_atomic_writes.sql');
  const start = full.indexOf("create or replace function public.collection_commit_roulette");
  const end = full.indexOf('commit;', start);
  if (start === -1 || end === -1) throw new Error('could not locate collection_commit_roulette block in 20260916141000_collection_atomic_writes.sql — file shape changed');
  const excerpt = full.slice(start, end);
  console.log('[harness] applying collection_commit_roulette v1 (verbatim excerpt from 20260916141000_collection_atomic_writes.sql:91-114)');
  await exec(excerpt, '20260916141000_collection_atomic_writes.sql (collection_commit_roulette excerpt)');
}

console.log('[harness] applying migration 20260922130000_roulette_targeted_replacement.sql (verbatim, full file)');
await exec(readMigration('20260922130000_roulette_targeted_replacement.sql'), '20260922130000_roulette_targeted_replacement.sql');

console.log('[harness] applying migration 20260924070000_roulette_pool_found_sync.sql — THE PR #23 MIGRATION UNDER TEST (verbatim, full file)');
await exec(readMigration('20260924070000_roulette_pool_found_sync.sql'), '20260924070000_roulette_pool_found_sync.sql');

console.log('[harness] schema ready — all objects collection_commit_roulette touches are now in place');

const verifySql = readFileSync(path.join(scriptsDir, 'verify-roulette-pool-found-sync.sql'), 'utf8');

console.log('[harness] running scripts/verify-roulette-pool-found-sync.sql');
await exec(verifySql, 'verify-roulette-pool-found-sync.sql');
console.log('[harness] script executed without error (its own trailing `rollback;` ran)');

// Confirm the disposable proof actually rolled back: no synthetic ZQA/ZQB rows, no leased scheduler.
const { rows: leftoverOffers } = await db.query(
  `select count(*)::int as n from public.offers where dest in ('ZQA','ZQB') and departure_at in ('2099-05-10','2099-06-10')`
);
const { rows: leftoverPool } = await db.query(
  `select count(*)::int as n from public.daily_origin_cheapest_pool where snapshot_at='2099-05-01T03:30:00Z'`
);
const { rows: schedulerState } = await db.query(
  `select owner, run_id from public.collection_scheduler_state where singleton`
);

if (leftoverOffers[0].n !== 0) throw new Error(`rollback check failed: ${leftoverOffers[0].n} synthetic offers rows survived`);
if (leftoverPool[0].n !== 0) throw new Error(`rollback check failed: ${leftoverPool[0].n} synthetic pool rows survived`);
if (schedulerState[0].owner !== null || schedulerState[0].run_id !== null) {
  throw new Error(`rollback check failed: scheduler lease not released (${JSON.stringify(schedulerState[0])})`);
}

console.log('[harness] rollback verified: zero synthetic offers/pool rows, scheduler lease released');
console.log('[harness] PASS — found-sync, identity-mismatch rollback, stale no-op, 29-min boundary, and no_result-replacement all reproduced from a clean checkout');

await db.close();
