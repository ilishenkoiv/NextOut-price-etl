import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../migrations/20261114120000_current_price_retention.sql', import.meta.url), 'utf8',
);

test('retention never targets current-price relations', () => {
  assert.match(migration, /observed_on < v_today/);
  assert.match(migration, /completed_at < clock_timestamp\(\) - interval '48 hours'/);
  assert.match(migration, /delete from public\.daily_origin_window_candidate_revisions/);
  assert.doesNotMatch(migration, /delete from public\.(?:prices|offers|window_prices)/);
  assert.match(migration, /confdeltype = 'c'/);
});

async function harness() {
  const db = new PGlite();
  await db.exec(`
    create role service_role;
    create role anon;
    create role authenticated;
    create table public.selected_price_refresh_control(
      singleton boolean primary key, enabled boolean not null, generation bigint not null,
      main12h_rollback boolean not null, updated_at timestamptz not null default clock_timestamp()
    );
    create table public.daily_origin_window_candidate_revisions(
      observed_on date not null, origin text not null, revision integer not null,
      snapshot_at timestamptz not null unique, candidate_rows integer not null,
      exact_request_groups integer not null, completed_at timestamptz not null,
      primary key(observed_on, origin, revision)
    );
    create table public.daily_origin_window_candidate_revision_candidates(
      observed_on date not null, origin text not null, snapshot_at timestamptz not null,
      flight_type text not null, departure_at date not null, return_at date not null, position smallint not null,
      primary key(snapshot_at, origin, flight_type, departure_at, return_at, position),
      foreign key(snapshot_at) references public.daily_origin_window_candidate_revisions(snapshot_at) on delete cascade
    );
    create function public.collection_prune_selected_carousel_revisions()
      returns integer language sql as 'select 0';
    insert into public.selected_price_refresh_control(singleton, enabled, generation, main12h_rollback)
      values(true, true, 1, false);
  `);
  await db.exec(migration);
  return db;
}

async function addRevision(db, { dayOffset, revision, ageHours, candidateRows = 1 }) {
  const snapshot = `2020-01-${String(revision).padStart(2, '0')}T00:00:00Z`;
  await db.query(`
    insert into public.daily_origin_window_candidate_revisions(
      observed_on, origin, revision, snapshot_at, candidate_rows, exact_request_groups, completed_at
    ) values(current_date + $1::integer, 'MUC', $2, $3::timestamptz, $4, 1,
      clock_timestamp() - ($5::text || ' hours')::interval)
  `, [dayOffset, revision, snapshot, candidateRows, ageHours]);
  await db.query(`
    insert into public.daily_origin_window_candidate_revision_candidates(
      observed_on, origin, snapshot_at, flight_type, departure_at, return_at, position
    ) values(current_date + $1::integer, 'MUC', $2::timestamptz, 'any', date '2030-01-01', date '2030-01-08', 1)
  `, [dayOffset, snapshot]);
}

test('only validated historical snapshots older than 48 hours are removed', async () => {
  const db = await harness();
  try {
    await addRevision(db, { dayOffset: 0, revision: 1, ageHours: 80 });
    await addRevision(db, { dayOffset: -1, revision: 2, ageHours: 12 });
    await addRevision(db, { dayOffset: -2, revision: 3, ageHours: 72 });
    await addRevision(db, { dayOffset: -2, revision: 4, ageHours: 72, candidateRows: 2 });

    const result = await db.query('select public.collection_prune_selected_carousel_revisions() as deleted');
    assert.equal(Number(result.rows[0].deleted), 1);
    const remaining = await db.query('select revision from public.daily_origin_window_candidate_revisions order by revision');
    assert.deepEqual(remaining.rows.map((row) => Number(row.revision)), [1, 2, 4]);
    const candidates = await db.query('select count(*)::integer as n from public.daily_origin_window_candidate_revision_candidates');
    assert.equal(Number(candidates.rows[0].n), 3, 'only the deleted parent cascades to its copy');
    const control = await db.query('select enabled from public.selected_price_refresh_control where singleton = true');
    assert.equal(control.rows[0].enabled, true);
  } finally {
    await db.close();
  }
});
