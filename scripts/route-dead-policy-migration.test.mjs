import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration=readFileSync(new URL('../migrations/20260927160000_route_dead_policy_transition.sql',import.meta.url),'utf8');
const rollback=readFileSync(new URL('./rollback-route-dead-policy-transition.sql',import.meta.url),'utf8');
const readback=readFileSync(new URL('./readback-route-dead-policy-transition.sql',import.meta.url),'utf8');

test('dead-policy migration is idempotent, fenced, horizon-complete and uses the exact temporary cutoff',()=>{
  assert.match(migration,/add column if not exists dead_policy/);
  assert.match(migration,/add column if not exists temporary_dead_until/);
  assert.match(migration,/owner=p_owner[\s\S]*fence=p_token[\s\S]*lease_until>now_at[\s\S]*for update/);
  assert.match(migration,/cardinality\(p_horizon\)<>6/);
  assert.match(migration,/cardinality\(h\.observed_months\)=6/);
  assert.match(migration,/temporary_cutoff constant timestamptz:='2026-09-28 22:00:00\+00'/);
  assert.match(migration,/now_at<temporary_cutoff[\s\S]*dead_policy:='temporary_immediate'/);
  assert.match(migration,/first_confirmed_no_price_at<=now_at-interval '7 days'/);
  assert.match(migration,/now_at>=coalesce\(h\.protected_until,h\.first_observed_at\)/);
  assert.match(migration,/collection_revive_route[\s\S]*status='active',dead_policy=null,temporary_dead_until=null/);
  assert.match(migration,/notify pgrst,'reload schema';\s*$/);
});

test('rollback reactivates temporary-only rows, restores the 30-day function and removes only new metadata',()=>{
  assert.match(rollback,/where dead_policy='temporary_immediate'/);
  assert.match(rollback,/first_confirmed_no_price_at<=now_at-interval '30 days'/);
  assert.match(rollback,/drop column if exists temporary_dead_until/);
  assert.match(rollback,/drop column if exists dead_policy/);
  assert.match(rollback,/notify pgrst,'reload schema';\s*$/);
});

test('operator readback exposes definitions, classification counts and transition violations without writes',()=>{
  assert.match(readback,/pg_get_functiondef\('public\.collection_record_route_observation/);
  assert.match(readback,/has_function_privilege\('service_role',p\.oid,'EXECUTE'\)/);
  assert.match(readback,/aclexplode\(coalesce\(p\.proacl,acldefault\('f',p\.proowner\)\)\)/);
  assert.match(readback,/has_function_privilege\('anon',p\.oid,'EXECUTE'\)/);
  assert.match(readback,/has_function_privilege\('authenticated',p\.oid,'EXECUTE'\)/);
  assert.match(readback,/'expired_temporary_rows'/);
  assert.match(readback,/'permanent_before_7d'/);
  assert.match(readback,/'protected_permanent_rows'/);
  assert.doesNotMatch(readback,/\b(update|insert|delete|alter|create|drop|perform)\b/i);
});

test('migration and rollback both execute idempotently against the existing route-health contract',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`
      create role service_role;create role anon;create role authenticated;
      create table public.collection_scheduler_state(singleton boolean primary key,owner uuid,fence bigint,lease_until timestamptz,checkpoint jsonb);
      create table public.route_price_health(
        origin text not null,dest text not null,status text not null default 'active',first_observed_at timestamptz not null default clock_timestamp(),
        protected_until timestamptz,first_confirmed_no_price_at timestamptz,last_confirmed_no_price_at timestamptz,last_price_at timestamptz,
        observation_pass bigint,observation_horizon text[] not null default '{}',observed_months text[] not null default '{}',
        pass_has_price boolean not null default false,updated_at timestamptz not null default clock_timestamp(),primary key(origin,dest));
    `);
    await db.exec(migration);await db.exec(migration);
    const added=await db.query(`select column_name from information_schema.columns where table_schema='public'
      and table_name='route_price_health' and column_name in ('dead_policy','temporary_dead_until') order by column_name`);
    assert.deepEqual(added.rows.map(r=>r.column_name),['dead_policy','temporary_dead_until']);
    const verified=await db.query(readback);
    const policy=JSON.parse(verified.rows[0].route_dead_policy_readback);
    assert.equal(policy.execute_privileges.length,2);
    for(const privileges of policy.execute_privileges){
      assert.equal(privileges.service_role,true);
      assert.equal(privileges.public,false);
      assert.equal(privileges.anon,false);
      assert.equal(privileges.authenticated,false);
    }
    await db.exec(rollback);await db.exec(rollback);
    const removed=await db.query(`select count(*)::integer n from information_schema.columns where table_schema='public'
      and table_name='route_price_health' and column_name in ('dead_policy','temporary_dead_until')`);
    assert.equal(removed.rows[0].n,0);
  }finally{await db.close();}
});
