import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../migrations/20261111120000_selected_carousel_revision_retention.sql', import.meta.url), 'utf8',
);

test('retention migration uses the existing writer control as the sole pause and lock boundary', () => {
  assert.match(migration, /set_config\('lock_timeout','5s',true\)/);
  assert.match(migration, /selected_price_refresh_control where singleton=true for update/);
  assert.match(migration, /selected_price_refresh_control where singleton=true for share/);
  assert.match(migration, /set enabled=false where singleton=true/);
  assert.match(migration, /exception when others then\s+update public\.selected_price_refresh_control set enabled=v_enabled/s);
  assert.match(migration, /complete_rank>3\s+and completed_at<clock_timestamp\(\)-interval '48 hours'/);
  assert.doesNotMatch(migration, /delete from public\.daily_origin_window_candidate_revision_candidates/);
  assert.match(migration, /delete from public\.daily_origin_window_candidate_revisions\s+where snapshot_at=any\(v_snapshots\)/);
  assert.match(migration, /confdeltype='c'/);
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
      exact_request_groups integer not null, completed_at timestamptz,
      primary key(observed_on,origin,revision)
    );
    create table public.daily_origin_window_candidate_revision_candidates(
      observed_on date not null, origin text not null, snapshot_at timestamptz not null,
      flight_type text not null, departure_at date not null, return_at date not null, position smallint not null,
      primary key(snapshot_at,origin,flight_type,departure_at,return_at,position),
      foreign key(snapshot_at) references public.daily_origin_window_candidate_revisions(snapshot_at) on delete cascade
    );
    create function public.collection_commit_selected_carousel_base_20261106(jsonb,bigint,jsonb)
      returns boolean language sql as 'select true';
    create function public.collection_commit_selected_carousel(jsonb,bigint,jsonb)
      returns boolean language sql as 'select true';
    insert into public.selected_price_refresh_control(singleton,enabled,generation,main12h_rollback)
      values(true,true,73,false);
  `);
  await db.exec(migration);
  return db;
}

async function addRevision(db, { origin, revision, ageHours, candidateRows = 1 }) {
  const month = origin === 'BER' ? '02' : '03';
  const snapshot = `2020-${month}-${String(revision).padStart(2, '0')}T00:00:00Z`;
  await db.query(`
    insert into public.daily_origin_window_candidate_revisions(
      observed_on,origin,revision,snapshot_at,candidate_rows,exact_request_groups,completed_at
    ) values(date '2020-02-01',$1,$2,$3::timestamptz,$4,1,clock_timestamp()-($5::text||' hours')::interval)
  `, [origin, revision, snapshot, candidateRows, ageHours]);
  await db.query(`
    insert into public.daily_origin_window_candidate_revision_candidates(
      observed_on,origin,snapshot_at,flight_type,departure_at,return_at,position
    ) values(date '2020-02-01',$1,$2::timestamptz,'any',date '2020-03-14',date '2020-03-16',1)
  `, [origin, snapshot]);
  return snapshot;
}

async function revisions(db, origin) {
  const result = await db.query(`
    select revision from public.daily_origin_window_candidate_revisions
    where observed_on=date '2020-02-01' and origin=$1 order by revision
  `, [origin]);
  return result.rows.map((row) => Number(row.revision));
}

test('retention preserves three complete revisions, age-protects newer parents, and removes only qualified dependents', async () => {
  const db = await harness();
  try {
    for (let revision = 1; revision <= 4; revision++) {
      await addRevision(db, { origin: 'BER', revision, ageHours: 60 - revision });
    }
    await addRevision(db, { origin: 'BER', revision: 5, ageHours: 1 });
    await addRevision(db, { origin: 'BER', revision: 6, ageHours: 80, candidateRows: 2 });
    for (let revision = 1; revision <= 4; revision++) {
      await addRevision(db, { origin: 'FRA', revision, ageHours: 70 - revision });
    }

    const result = await db.query('select public.collection_prune_selected_carousel_revisions() as deleted');
    assert.equal(Number(result.rows[0].deleted), 3, 'only two BER and one FRA old, non-protected parents qualify');
    assert.deepEqual(await revisions(db, 'BER'), [3, 4, 5, 6], 'newest three complete plus the incomplete parent remain');
    assert.deepEqual(await revisions(db, 'FRA'), [2, 3, 4], 'the newest three complete FRA revisions remain');
    const candidates = await db.query(
      'select origin,count(*)::integer as n from public.daily_origin_window_candidate_revision_candidates group by origin order by origin',
    );
    assert.deepEqual(candidates.rows, [{ origin: 'BER', n: 4 }, { origin: 'FRA', n: 3 }],
      'qualified parent deletion cascades only to its dependents');
    const control = await db.query('select enabled from public.selected_price_refresh_control where singleton=true');
    assert.equal(control.rows[0].enabled, true, 'successful retention restores the captured writer admission');
  } finally {
    await db.close();
  }
});

test('a failed retention transaction leaves writer admission unchanged', async () => {
  const db = await harness();
  try {
    await db.exec('drop table public.daily_origin_window_candidate_revision_candidates');
    await assert.rejects(
      db.query('select public.collection_prune_selected_carousel_revisions()'),
      /daily_origin_window_candidate_revision_candidates/,
    );
    const control = await db.query('select enabled from public.selected_price_refresh_control where singleton=true');
    assert.equal(control.rows[0].enabled, true, 'failure restores the prior enabled value');
  } finally {
    await db.close();
  }
});

test('retention restores an already-paused writer admission after a successful no-op', async () => {
  const db = await harness();
  try {
    await db.exec('update public.selected_price_refresh_control set enabled=false where singleton=true');
    const result = await db.query('select public.collection_prune_selected_carousel_revisions() as deleted');
    assert.equal(Number(result.rows[0].deleted), 0);
    const control = await db.query('select enabled from public.selected_price_refresh_control where singleton=true');
    assert.equal(control.rows[0].enabled, false, 'success restores the captured disabled admission');
  } finally {
    await db.close();
  }
});
