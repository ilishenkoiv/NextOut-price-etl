import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration=readFileSync(new URL('../migrations/20261103120000_selected_carousel_revision_publication.sql',import.meta.url),'utf8');

test('selected carousel revisions are per-origin, fenced, durable-OFF, and public-read-only',()=>{
  assert.match(migration,/selected_price_refresh_control[\s\S]*enabled boolean not null default false/);
  assert.match(migration,/main12h_rollback boolean not null default false/);
  assert.match(migration,/daily_origin_window_candidate_revisions[\s\S]*primary key\(observed_on,origin,revision\)/);
  assert.match(migration,/generation=p_generation/);
  assert.match(migration,/not in \('found','confirmed_absent','error','technical','timeout','rate_limit','unconfirmed'\)/);
  assert.match(migration,/incomplete selected carousel revision/);
  assert.match(migration,/stale selected carousel ticket snapshot/);
  assert.match(migration,/daily_origin_window_candidate_runs r\s+where r\.observed_on=v_day and r\.origin=v_origin and r\.snapshot_at=v_snapshot/);
  assert.match(migration,/from public\.daily_origin_window_candidates where observed_on=v_day and origin=v_origin and snapshot_at=v_snapshot;/);
  assert.match(migration,/from public\.daily_origin_window_candidates where observed_on=v_day and origin=v_origin and snapshot_at=v_snapshot and not exists/);
  assert.match(migration,/pg_advisory_xact_lock\(hashtext\('selected-carousel:'/);
  assert.match(migration,/revoke all on public\.daily_origin_window_candidate_revisions,public\.daily_origin_window_candidate_revision_candidates from public,anon,authenticated/);
  assert.match(migration,/grant select on public\.daily_origin_window_candidate_revisions,public\.daily_origin_window_candidate_revision_candidates to anon,authenticated/);
  assert.doesNotMatch(migration,/daily_window_candidate_epochs/);
});

async function staleTicketHarness(){
  const db=new PGlite();
  await db.exec(`
    create role service_role; create role anon; create role authenticated;
    create table public.daily_origin_window_candidate_runs(
      observed_on date not null, origin text not null, snapshot_at timestamptz not null,
      candidate_rows integer not null, exact_request_groups integer not null
    );
    create table public.daily_origin_window_candidates(
      observed_on date not null, origin text not null, snapshot_at timestamptz not null,
      flight_type text not null, departure_at date not null, return_at date not null
    );
  `);
  await db.exec(migration);
  await db.exec(`update public.selected_price_refresh_control
    set enabled=true, generation=73 where singleton=true`);
  return db;
}

test('stale selected-carousel ticket RPC rejects its exact snapshot before creating a revision',async()=>{
  const db=await staleTicketHarness();
  try{
    const ticket={observed_on:'2099-02-03',origin:'MUC',snapshot_at:'2099-02-03T03:30:00Z',
      destination_id:'fixture:stale',flight_type:'any',departure_at:'2099-02-14',return_at:'2099-02-16'};
    const result={status:'technical',outcome:'retain_failed'};
    await assert.rejects(
      db.query('select public.collection_commit_selected_carousel($1::jsonb,$2::bigint,$3::jsonb)',
        [JSON.stringify(ticket),73,JSON.stringify(result)]),
      /stale selected carousel ticket snapshot/,
    );
    const revisions=await db.query('select count(*)::integer n from public.daily_origin_window_candidate_revisions');
    const candidates=await db.query('select count(*)::integer n from public.daily_origin_window_candidate_revision_candidates');
    assert.equal(revisions.rows[0].n,0);
    assert.equal(candidates.rows[0].n,0);
  }finally{await db.close();}
});
