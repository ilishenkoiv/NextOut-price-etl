import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../migrations/20261108230000_selected_carousel_revision_fence.sql', import.meta.url), 'utf8');
const recoveryMigration = readFileSync(new URL('../migrations/20261106120000_selected_price_refresh_recovery.sql', import.meta.url), 'utf8');

test('selected-carousel revision fence changes only the locked base writer', () => {
  assert.match(migration, /create or replace function public\.collection_commit_selected_carousel_base_20261106\(/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtext\('selected-carousel:'/);
  assert.match(migration, /completed_at>v_next-interval '30 minutes'/);
  assert.ok(
    migration.indexOf("if not exists(select 1 from public.selected_price_refresh_control")
      < migration.indexOf("stale selected carousel ticket snapshot")
      && migration.indexOf("stale selected carousel ticket snapshot")
        < migration.indexOf("selected_carousel_replacement_pending"),
    'control and stale-ticket checks remain ahead of the fence',
  );
  assert.match(migration, /set_config\('nextout\.selected_carousel_replacement_pending'/);
  assert.doesNotMatch(migration, /create or replace function public\.collection_commit_selected_carousel\(/);
  assert.match(
    recoveryMigration,
    /collection_commit_selected_carousel_base_20261106\(\s*p_ticket,p_generation,jsonb_build_object\('status','confirmed_absent'\)\s*\)[\s\S]*?collection_commit_selected_carousel_base_20261106\(/,
  );
});

async function fenceHarness({ withRecoveryWrapper = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role service_role;
    create role anon;
    create role authenticated;
    create table public.selected_price_refresh_control(
      singleton boolean primary key, enabled boolean not null, generation bigint not null,
      main12h_rollback boolean not null, updated_at timestamptz not null default clock_timestamp()
    );
    create table public.daily_origin_window_candidate_runs(
      observed_on date not null, origin text not null, snapshot_at timestamptz not null,
      candidate_rows integer not null, exact_request_groups integer not null
    );
    create table public.daily_origin_window_candidates(
      observed_on date not null, origin text not null, snapshot_at timestamptz not null,
      market text not null, flight_type text not null, region_codes text[] not null,
      window_kind text not null, departure_at date not null, return_at date not null,
      position smallint not null, dest text not null, destination_id text not null,
      exact_price numeric(10,2) not null, currency text not null, transfers smallint,
      airline text, exact_observed_at timestamptz not null, refresh_status text not null,
      refresh_checked_at timestamptz, last_error_kind text, price_source jsonb not null
    );
    create table public.daily_origin_window_candidate_revisions(
      observed_on date not null, origin text not null, revision integer not null,
      snapshot_at timestamptz not null, candidate_rows integer not null,
      exact_request_groups integer not null, completed_at timestamptz not null default clock_timestamp(),
      primary key(observed_on, origin, revision), unique(snapshot_at), unique(observed_on, origin, snapshot_at)
    );
    create table public.daily_origin_window_candidate_revision_candidates(
      observed_on date not null, origin text not null, snapshot_at timestamptz not null,
      market text not null, flight_type text not null, region_codes text[] not null,
      window_kind text not null, departure_at date not null, return_at date not null,
      position smallint not null, dest text not null, destination_id text not null,
      source_destination_id text not null, exact_price numeric(10,2) not null, currency text not null,
      transfers smallint, airline text, exact_observed_at timestamptz not null,
      refresh_status text not null, refresh_checked_at timestamptz, last_error_kind text,
      price_source jsonb not null, primary key(snapshot_at, origin, flight_type, departure_at, return_at, position)
    );
    create table public.roulette_pool_ticket_revisions(
      snapshot_at timestamptz, origin text, flight_type text, rank integer, dest text,
      departure_at date, return_at date, generation bigint
    );
    create function public.collection_commit_selected_roulette(uuid,bigint,bigint,jsonb,jsonb)
      returns boolean language sql as 'select false';
    create function public.collection_commit_selected_carousel(jsonb,bigint,jsonb)
      returns boolean language sql as 'select false';
    insert into public.selected_price_refresh_control(singleton,enabled,generation,main12h_rollback)
      values(true,true,73,false);
  `);
  if (withRecoveryWrapper) {
    await db.exec(recoveryMigration);
  } else {
    await db.exec(`
      create function public.collection_commit_selected_carousel_base_20261106(jsonb,bigint,jsonb)
        returns boolean language sql as 'select false';
    `);
  }
  await db.exec(migration);
  for (const [origin, dest, destinationId] of [['BER', 'BCN', 'barcelona'], ['FRA', 'FCO', 'rome']]) {
    await db.exec(`
      insert into public.daily_origin_window_candidates(
        observed_on,origin,snapshot_at,market,flight_type,region_codes,window_kind,departure_at,return_at,
        position,dest,destination_id,exact_price,currency,transfers,airline,exact_observed_at,refresh_status,
        refresh_checked_at,last_error_kind,price_source
      ) values(
        date '2099-02-03','${origin}',timestamptz '2099-02-03 03:30:00+00','DE','any',array['DE'],'weekend',
        date '2099-02-14',date '2099-02-16',1,'${dest}','${destinationId}',99,'EUR',0,'Fixture Air',
        timestamptz '2099-02-01 12:00:00+00','fresh',timestamptz '2099-02-01 12:00:00+00',null,'{}'::jsonb
      );
      insert into public.daily_origin_window_candidate_runs(observed_on,origin,snapshot_at,candidate_rows,exact_request_groups)
        values(date '2099-02-03','${origin}',timestamptz '2099-02-03 03:30:00+00',1,1);
    `);
  }
  return db;
}

function ticket(origin, destinationId, dest) {
  return {
    observed_on: '2099-02-03', origin, snapshot_at: '2099-02-03T03:30:00Z',
    destination_id: destinationId, dest, flight_type: 'any', departure_at: '2099-02-14', return_at: '2099-02-16',
  };
}

function foundResult() {
  return {
    status: 'found', outcome: 'retain_fresh',
    fare: { price: 99, updated_at: '2099-02-01T12:00:00Z' },
  };
}

async function commit(db, selectedTicket) {
  const result = await db.query(
    'select public.collection_commit_selected_carousel_base_20261106($1::jsonb,$2::bigint,$3::jsonb) as committed',
    [JSON.stringify(selectedTicket), 73, JSON.stringify(foundResult())],
  );
  assert.equal(result.rows[0].committed, true);
}

async function commitWrapper(db, selectedTicket, result) {
  const committed = await db.query(
    'select public.collection_commit_selected_carousel($1::jsonb,$2::bigint,$3::jsonb) as committed',
    [JSON.stringify(selectedTicket), 73, JSON.stringify(result)],
  );
  assert.equal(committed.rows[0].committed, true);
}

async function count(db, table, origin) {
  const result = await db.query(`select count(*)::integer as n from public.${table} where origin=$1`, [origin]);
  return result.rows[0].n;
}

test('selected-carousel base fence keeps one same-origin revision, permits another origin, then republishes after 30 minutes', async () => {
  const db = await fenceHarness();
  try {
    await commit(db, ticket('BER', 'barcelona', 'BCN'));
    assert.equal(await count(db, 'daily_origin_window_candidate_revisions', 'BER'), 1);
    assert.equal(await count(db, 'daily_origin_window_candidate_revision_candidates', 'BER'), 1);

    await commit(db, ticket('BER', 'barcelona', 'BCN'));
    assert.equal(await count(db, 'daily_origin_window_candidate_revisions', 'BER'), 1, 'a second valid BER call inside 30 minutes is a successful no-write');
    assert.equal(await count(db, 'daily_origin_window_candidate_revision_candidates', 'BER'), 1);

    await commit(db, ticket('FRA', 'rome', 'FCO'));
    assert.equal(await count(db, 'daily_origin_window_candidate_revisions', 'FRA'), 1, 'another origin remains independent');
    assert.equal(await count(db, 'daily_origin_window_candidate_revision_candidates', 'FRA'), 1);

    await db.exec(`update public.daily_origin_window_candidate_revisions
      set completed_at=clock_timestamp()-interval '31 minutes'
      where observed_on=date '2099-02-03' and origin='BER'`);
    await commit(db, ticket('BER', 'barcelona', 'BCN'));
    assert.equal(await count(db, 'daily_origin_window_candidate_revisions', 'BER'), 2, 'a BER publication is allowed after the fence');
    assert.equal(await count(db, 'daily_origin_window_candidate_revision_candidates', 'BER'), 2);
  } finally {
    await db.close();
  }
});

test('selected-carousel fence preserves the real wrapper replacement pair and fences later duplicates', async () => {
  const db = await fenceHarness({ withRecoveryWrapper: true });
  try {
    await db.exec(`
      insert into public.daily_origin_window_candidates(
        observed_on,origin,snapshot_at,market,flight_type,region_codes,window_kind,departure_at,return_at,
        position,dest,destination_id,exact_price,currency,transfers,airline,exact_observed_at,refresh_status,
        refresh_checked_at,last_error_kind,price_source
      ) values(
        date '2099-02-03','BER',timestamptz '2099-02-03 03:30:00+00','DE','any',array['DE'],'weekend',
        date '2099-02-14',date '2099-02-16',2,'FCO','rome',88,'EUR',0,'Fixture Air',
        clock_timestamp(),'fresh',clock_timestamp(),null,'{}'::jsonb
      );
      update public.daily_origin_window_candidates
        set exact_observed_at=clock_timestamp(), refresh_checked_at=clock_timestamp()
        where observed_on=date '2099-02-03' and origin='BER';
      update public.daily_origin_window_candidate_runs
        set candidate_rows=2, exact_request_groups=1
        where observed_on=date '2099-02-03' and origin='BER';
    `);
    const alternate = (await db.query(`
      select exact_observed_at::text as updated_at from public.daily_origin_window_candidates
      where observed_on=date '2099-02-03' and origin='BER' and destination_id='rome'
    `)).rows[0];
    const replacement = {
      observed_on: '2099-02-03', snapshot_at: '2099-02-03T03:30:00Z', origin: 'BER',
      destination_id: 'rome', dest: 'FCO', flight_type: 'any', departure_at: '2099-02-14', return_at: '2099-02-16',
      price: 88, transfers: 0, airline: 'Fixture Air', updated_at: alternate.updated_at, price_source: {},
    };

    await commitWrapper(db, ticket('BER', 'barcelona', 'BCN'), {
      status: 'confirmed_absent', outcome: 'replaced', replacement,
    });
    assert.equal(await count(db, 'daily_origin_window_candidate_revisions', 'BER'), 2, 'the wrapper materializes both atomic replacement facts');
    assert.equal(await count(db, 'daily_origin_window_candidate_revision_candidates', 'BER'), 4);
    const finalState = await db.query(`
      select source_destination_id,dest,refresh_status from public.daily_origin_window_candidate_revision_candidates
      where origin='BER' and snapshot_at=(
        select snapshot_at from public.daily_origin_window_candidate_revisions
        where observed_on=date '2099-02-03' and origin='BER' order by revision desc limit 1
      ) order by source_destination_id
    `);
    assert.deepEqual(finalState.rows, [
      { source_destination_id: 'barcelona', dest: 'BCN', refresh_status: 'failed' },
      { source_destination_id: 'rome', dest: 'FCO', refresh_status: 'fresh' },
    ], 'the old city stays failed while its exact-date alternate remains published');

    await commitWrapper(db, ticket('BER', 'barcelona', 'BCN'), foundResult());
    assert.equal(await count(db, 'daily_origin_window_candidate_revisions', 'BER'), 2, 'a separate same-origin snapshot inside 30 minutes is a successful no-write');

    await assert.rejects(
      db.query(
        'select public.collection_commit_selected_carousel($1::jsonb,$2::bigint,$3::jsonb)',
        [JSON.stringify({ ...ticket('BER', 'barcelona', 'BCN'), snapshot_at: '2099-02-03T04:30:00Z' }), 73, JSON.stringify(foundResult())],
      ),
      /stale selected carousel ticket snapshot/,
      'a stale ticket is rejected before the no-write fence',
    );

    await commitWrapper(db, ticket('FRA', 'rome', 'FCO'), foundResult());
    assert.equal(await count(db, 'daily_origin_window_candidate_revisions', 'FRA'), 1, 'another origin remains independent');

    await db.exec(`update public.daily_origin_window_candidate_revisions
      set completed_at=clock_timestamp()-interval '31 minutes'
      where observed_on=date '2099-02-03' and origin='BER'`);
    await commitWrapper(db, ticket('BER', 'barcelona', 'BCN'), foundResult());
    assert.equal(await count(db, 'daily_origin_window_candidate_revisions', 'BER'), 3, 'BER publishes again after the strict 30-minute boundary');
  } finally {
    await db.close();
  }
});
