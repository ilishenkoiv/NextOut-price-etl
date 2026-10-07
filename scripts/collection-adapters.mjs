import { probeType, fetchCalendarMonth, selectCombo } from './fetch-prices.mjs';
import { monthlyQuoteProvenance } from './quote-integrity.mjs';
import { withPriceProvenance } from './price-provenance.mjs';
import { marketForOrigin } from '../src/data/origin-markets.js';
import { isSuspendedOrigin } from '../src/data/origins.js';
import { mainPlan, tailPlan, fastPlan, nextMonth, horizon, resolveTrancheDests, catalogue } from './collection-planning.mjs';
import { computeAllWindows } from './collection-windows.mjs';
import { buildBreakWindows } from './break-windows.mjs';
import { CollectionYield } from './collection-provider.mjs';
import { withSupabaseRetry } from './supabase-retry.mjs';
import { logDbError, dbErrorCode } from './db-error.mjs';
import { classifyResponse, ticketFromFeedback } from './check-flight-price-feedback.mjs';
import { calendarMonthsAgoIso } from './destination-request-retention.mjs';
import { expansionTargets } from '../src/data/expansion-targets.js';
import { originDueThisCycle } from './priority-market-schedule.mjs';
import { maintenanceDue, maintenanceMustStop, isQuarterlyMaintenanceDay } from './maintenance-window.mjs';
import { retentionCutoff, shouldDeleteSnapshot, positiveDays, SNAPSHOT_RETENTION_DAYS, PROGRESS_RETENTION_DAYS } from './price-storage-retention.mjs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { recordRead } from './collection-egress.mjs';
import { preserveCarouselSixMonthMinimum } from './carousel-six-month-contract.mjs';

const PRICE_ORDER = ['origin','dest','month'];
const WINDOW_ORDER = ['origin','dest','flight_type','departure_at','return_at'];
const DAY = 86400000;
export const PRIORITY_AUDIT_BATCH = 10;
// Keep the scheduler's admission bound identical to the adapter's own hard deadline.
// A larger advertised unit strands usable time at the end of the five-minute priority budget.
export const PRIORITY_UNIT_MAX_MS = 35_000;
export const MAIN_REQUIRED_PROVIDER_CALLS = 4;
// MAIN is a bounded adapter unit, not a continuous slot: each tick does at most MAIN_UNIT_WORK_MS
// of provider/DB work before returning its checkpoint, admitted only if MAIN_UNIT_ADMIT_MS still
// fits the caller's deadline. main-24h-sim.mjs imports these so the capacity model reflects the
// same bounded-unit granularity as the real adapter, instead of treating a nominal SLOTS minute
// budget as if it converts to cells at a flat continuous rate.
export const MAIN_UNIT_WORK_MS = 75_000;
export const MAIN_UNIT_ADMIT_MS = 90_000;
// One replay of the pass's unresolved mandatory cells is allowed. A still-unresolved cell then
// remains explicit in the final attempted-pass checkpoint; it is never reclassified as coverage.
export const MAIN_MAX_RETRY_ROUNDS = 1;
export function projectMainCellMs({requestMs,dbMs=0,calendarFallback=false,retryCalls=0}){
  if(![requestMs,dbMs,retryCalls].every(Number.isFinite)||requestMs<0||dbMs<0||retryCalls<0)throw new Error('Invalid MAIN projection');
  return(MAIN_REQUIRED_PROVIDER_CALLS+Number(calendarFallback)+retryCalls)*requestMs+dbMs;
}
function addIsoDays(day,n){const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function addIsoMonths(day,n){const d=new Date(day+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+n);return d.toISOString().slice(0,10);}
// Mirrors the read-only app consumer: breakWindows uses lead=10 days, horizon=4 months and only
// factual `weekend`/`holiday` windows. Both exact variants remain separate rows; no top-N cap.
export function selectWindowConsumerSet(rows,day){const min=addIsoDays(day,10),max=addIsoMonths(day,4);return rows.filter(t=>
  t.departure_at>=min&&t.departure_at<=max&&t.return_at>t.departure_at&&['weekend','holiday'].includes(t.window_kind));}
export function windowConsumerSetId(rows,day){return`window-consumer:${day}:`+createHash('sha256').update(rows.map(t=>
  [t.origin,t.dest,t.flight_type,t.departure_at,t.return_at].join('|')).join('\n')).digest('hex').slice(0,20);}
export function groupWindowConsumerTickets(rows){const groups=new Map();for(const row of rows){const key=[row.origin,row.dest,row.departure_at,row.return_at].join('|');
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}return[...groups.values()].map(group=>group.sort((a,b)=>a.flight_type.localeCompare(b.flight_type)));}
export function createAdapters({ db, store, provider, wave = 0, clock = Date.now, setDbDeadline = () => {}, getState = () => null,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random }) {
  const exactKey=t=>[t.origin,t.dest,t.flight_type,t.departure_at,t.return_at].join('|');
  // PILOT, off by default: uniform 30-minute price refresh for every already-selected ticket
  // (legacy) unless explicitly opted into the market/time-of-day cadence.
  const pilotMarketSchedule=process.env.PRIORITY_MARKET_SCHEDULE==='pilot';
  // Bound the transient-retry backoff so no attempt (retry wait + one ~8s request +
  // the 9s boundary guard) can run past the unit/session deadline. If nothing fits,
  // delays is empty and the operation runs exactly once, failing honestly.
  function retryBudget(deadline) {
    const base = [1000, 3000, 9000]; const delays = []; let projected = clock();
    for (const d of base) { projected += d + 8000; if (projected + 9000 > deadline) break; delays.push(d); }
    return { label: 'coordinator db', delays, sleep, random, now: clock, warn: () => {} };
  }
  // A retry rebuilds a fresh PostgREST builder via `build` and re-checks the fenced
  // lease before every attempt. Only reads and PROVEN-idempotent writes pass retry:true;
  // permanent Postgres/RLS/schema errors are non-transient and surface unchanged, so a
  // failed operation never becomes a false success and never masks a real error.
  // `op` names the operation for the structured db_error log line and the thrown message —
  // every call site below passes one so a failure is traceable to what it was doing, not just
  // reduced to an opaque error code.
  async function query(build, deadline = Infinity, { retry = false, op = 'db_operation' } = {}) {
    if (clock() + 9000 >= deadline) throw new CollectionYield('Database unit would cross boundary');
    let attempts = 0;
    const attempt = async () => {
      attempts++;
      if (!await store.lease()) throw new Error('Database operation forbidden: lease lost');
      return build();
    };
    const result = retry ? await withSupabaseRetry(attempt, retryBudget(deadline)) : await attempt();
    if (result.error) {
      logDbError({ op, error: result.error, status: result.status, attempt: attempts });
      const failure = new Error(`Collection database operation failed: ${op} (${dbErrorCode(result.error)})`);
      // Same safe-to-log text db-error.mjs already logs (never request secrets), attached so a
      // caller can react to one exact, known Postgres exception without pattern-matching the
      // formatted message string or handling every error sharing this op/code as if it were that
      // one case (a bare P0001 covers several distinct raised exceptions in collection_commit_roulette).
      failure.dbOp = op; failure.dbCode = dbErrorCode(result.error);
      failure.dbMessage = typeof result.error?.message === 'string' ? result.error.message : null;
      throw failure;
    }
    return result.data;
  }
  async function load(table, columns, order, apply = q => q, deadline = Infinity, op = table) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const data = await query(() => {
        let q = db.from(table).select(columns); for (const key of order) q = q.order(key);
        return apply(q).range(from, from + 999);
      }, deadline, { retry: true, op });
      rows.push(...data); recordRead(table, data); if (data.length < 1000) return rows;
    }
  }
  const watches = deadline => load('price_watch_push_rules','origin,dest,watch_scope,country_code',
    ['installation_id','watch_id'],q => q.eq('active',true),deadline);
  async function durablePlan(task, job, build) {
    return store.plan(`coordinator/${task}-${job.id}-${job.checkpoint?.wave??wave}.json`, build);
  }
  async function commit(name, payload, deadline) {
    // collection_commit_main/window/roulette are idempotent by construction (fenced,
    // upsert-on-conflict / delete-by-PK, price_history append guarded against the
    // persisted row), so a retry after a committed-but-lost response cannot double-write.
    const accepted=await query(() => db.rpc(name, { ...store.args(), ...payload }), deadline, { retry: true, op: name });
    if(accepted!==true)throw new Error('Collection write was not acknowledged');
    return accepted;
  }

  // Claims and completes ONE flight_price_audits row, or returns claimed:false when the queue is
  // empty. Shared by the priority phase's one-per-cycle trickle audit and the nightly maintenance
  // block's full drain (see check-flight-price-feedback.mjs's standalone main(), which this
  // mirrors without that script's GitHub-idle polling — the coordinator already owns the lease).
  async function claimAndFinishOneAudit(deadline, today) {
    const rows=await query(()=>db.rpc('claim_flight_price_audit'),deadline,{op:'claim_flight_price_audit'});
    const row=rows?.[0];
    if(!row)return{claimed:false};
    const ticket=ticketFromFeedback(row.feedback,today);let outcome={status:'not_requested',detail:'missing_exact_context'};
    if(ticket && isSuspendedOrigin(ticket.origin)) outcome={status:'error',detail:'departure_suspended'};
    else if(ticket){
      const params=new URLSearchParams({origin:ticket.origin,destination:ticket.dest,departure_at:ticket.depart,return_at:ticket.ret,
        direct:String(ticket.mode==='direct'),market:marketForOrigin(ticket.origin),currency:'eur',one_way:'false',limit:'500'});
      const response=await provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?'+params,deadline-9000);
      outcome=response.kind==='ok'?classifyResponse(response.json,ticket):{status:'error',detail:'provider_error'};
    }
    const result=await query(()=>db.rpc('finish_flight_price_audit',{p_feedback_id:row.feedback_id,p_claim_token:row.claim_token,
      p_status:outcome.status,p_price:outcome.price??null,p_detail:outcome.detail,p_run_id:store.runId}),deadline,{op:'finish_flight_price_audit'});
    if(result!==true)throw new Error('Audit claim expired before completion');
    return{claimed:true,queuedAt:Date.parse(row.created_at??row.feedback?.created_at)};
  }

  const main = {
    // Main does not publish the roulette pool. The coordinator's checkpointed daily-selection
    // phase owns membership before the schedule engine starts; MAIN only refreshes source offers.
    // Four mandatory upstream calls (two return windows × direct/any) need more than the former
    // 30s unit at the 8s timeout. 75s work / 90s admission preserves the boundary guard.
    maxUnitMs: MAIN_UNIT_ADMIT_MS,
    async step({ job, deadline }) {
      const unitEnd = Math.min(deadline, clock() + MAIN_UNIT_WORK_MS);
      let cp = job.checkpoint ?? { cursor: 0, errors: 0, wave };
      const pinnedWave=cp.wave??wave;
      cp={...cp,wave:pinnedWave};
      try {
        const plan = await durablePlan('main',{...job,checkpoint:cp},async () => {
          const months = horizon(job.planDate);
          const prices = await load('prices','origin,dest,month,direct,any_stops',PRICE_ORDER,q=>q.in('month',months),unitEnd);
          const routeHealth = await load('route_price_health','origin,dest,status,dead_policy,temporary_dead_until',['origin','dest'],undefined,unitEnd);
          const watchRows = await watches(unitEnd);
          const holidays = await load('public_holidays','country,subdivision_code,level,date',['country','subdivision_code','date'],q=>q.gte('date',months[0]+'-01').lt('date',nextMonth(months.at(-1))+'-01'),unitEnd);
          const regions = await load('origin_regions','airport,calendar_subdivision_code',['airport'],undefined,unitEnd);
          const codes = new Set(regions.map(r=>r.calendar_subdivision_code));
          const days = new Set(holidays.filter(h=>codes.has(h.subdivision_code) || (h.level==='country' && [...codes].some(c=>c.startsWith(h.country+'-')))).map(h=>h.date));
          const trancheDests = resolveTrancheDests(process.env.EXPANSION_TRANCHE_DESTS);
          return { ...mainPlan({date:job.planDate,wave:pinnedWave,prices,watches:watchRows,routeHealth,trancheDests}),
            breakKeys:[...buildBreakWindows(days,months[0]+'-01',nextMonth(months.at(-1))+'-01').keySet] };
        });
        // cellOrder (when present) front-loads the bounded expansion tranche, then keeps every
        // remaining cell in the original month-major order. It is a permutation of the same cell ids,
        // so `total` and cursor/resume semantics are identical to the legacy identity ordering.
        const total = plan.cellOrder ? plan.cellOrder.length : plan.routes.length * plan.months.length;
        const expansion = new Set(expansionTargets(pinnedWave).map(item => item.iata));
        // Existing in-flight checkpoints predate outcome accounting. Preserve their cursor without
        // inventing evidence: already-attempted cells are explicitly legacyUnclassified. A fresh
        // pass starts at zero and can prove coverage from its own mandatory probe outcomes.
        const priorCursor=Number(cp.cursor??0);
        cp.outcomes=cp.outcomes??{attempted:priorCursor,confirmedPrice:0,confirmedEmpty:0,unresolved:0,
          legacyUnclassified:priorCursor};
        cp.unresolvedCells=Array.isArray(cp.unresolvedCells)?cp.unresolvedCells:[];
        cp.total=total;
        if(cp.cursor>=total&&cp.unresolvedCells.length&&(cp.retryRound??0)<MAIN_MAX_RETRY_ROUNDS&&!Array.isArray(cp.retryQueue)){
          cp.retryQueue=[...cp.unresolvedCells];cp.retryCursor=0;cp.retryNext=[];
        }
        // A cursor is advanced only after the complete cell has been committed.
        while ((cp.cursor < total||(Array.isArray(cp.retryQueue)&&cp.retryCursor<cp.retryQueue.length))&&clock() + 15000 < unitEnd) {
          const retrying=cp.cursor>=total;
          const cellId=retrying?cp.retryQueue[cp.retryCursor]:(plan.cellOrder ? plan.cellOrder[cp.cursor] : cp.cursor);
          const route = plan.routes[cellId % plan.routes.length];
          const month = plan.months[Math.floor(cellId / plan.routes.length)];
          if (isSuspendedOrigin(route.origin)) {
            if (!await store.lease()) throw new Error('Suspended cell advancement forbidden: lease lost');
            // Advance in the ORIGINAL order, keeping total/object/date/start/wave unchanged.
            // Suspension is neither a provider attempt nor confirmed-empty/route-dead evidence.
            if (retrying) {
              cp.retryNext.push(cellId); cp.retryCursor++;
              cp.retrySuspendedCells=[...new Set([...(cp.retrySuspendedCells??[]),cellId])];
              if(cp.retryCursor>=cp.retryQueue.length){
                cp.retryRound=(cp.retryRound??0)+1;cp.unresolvedCells=[...cp.retryNext];
                delete cp.retryQueue;delete cp.retryCursor;delete cp.retryNext;
                break;
              }
            } else {
              cp={...cp,cursor:cp.cursor+1,outcomes:{...cp.outcomes,suspended:(cp.outcomes.suspended??0)+1},
                suspendedCells:[...(cp.suspendedCells??[]),cellId]};
              if(cp.cursor===total&&cp.unresolvedCells.length&&(cp.retryRound??0)<MAIN_MAX_RETRY_ROUNDS){
                cp.retryQueue=[...cp.unresolvedCells];cp.retryCursor=0;cp.retryNext=[];
                return{status:'yield',checkpoint:cp};
              }
            }
            continue;
          }
          const request = url => provider.request(url, unitEnd - 9000);
          // Owner invariant: BOTH variants are mandatory for every cell. `any` is the provider's
          // actual direct=false result and may legitimately be cheaper than (or include) direct.
          // A boundary/restart between probes leaves cp.cursor unchanged, so both replay safely.
          const directResult = await probeType(route.origin,route.dest,month,nextMonth(month),true,request);
          const anyResult = await probeType(route.origin,route.dest,month,nextMonth(month),false,request);
          let calendarResult = null;
          // Calendar is positive-only supplemental evidence after TWO confirmed-empty required
          // probes. It never masks a failed required probe and never supplies no-price evidence.
          if(directResult.ok&&directResult.min==null&&anyResult.ok&&anyResult.min==null)
            calendarResult=await fetchCalendarMonth(route.origin,route.dest,month,request);
          const direct = directResult.min ?? (calendarResult?.ok&&calendarResult.type==='direct'?calendarResult.min:null);
          const any = anyResult.min ?? (calendarResult?.ok&&calendarResult.type==='any'?calendarResult.min:null);
          const hasPrice=direct!=null||any!=null;
          if (hasPrice) {
            const directSource=directResult.min!=null?monthlyQuoteProvenance(directResult.offers,directResult.min)
              : calendarResult?.type==='direct'?{...monthlyQuoteProvenance(calendarResult.offers,calendarResult.min),source:'calendar'}:null;
            const anySource=anyResult.min!=null?monthlyQuoteProvenance(anyResult.offers,anyResult.min)
              : calendarResult?.type==='any'?{...monthlyQuoteProvenance(calendarResult.offers,calendarResult.min),source:'calendar'}:null;
            const price = withPriceProvenance([{ origin:route.origin,dest:route.dest,market:marketForOrigin(route.origin),month,
              direct,any_stops:any,direct_observed:directResult.ok,any_observed:anyResult.ok,
              updated_at:new Date(clock()).toISOString(),price_source:{variants:{...(directSource?{direct:directSource}:{}),...(anySource?{any:anySource}:{})}} }],'prices')[0];
            const offers = withPriceProvenance(selectCombo([...directResult.offers,...anyResult.offers,...(calendarResult?.offers??[])],
              route.origin,route.dest,new Set(plan.breakKeys)),'offers');
            await commit('collection_commit_main',{ p_price:price,p_offers:offers },unitEnd);
          }
          // Positive evidence revives immediately even if the other required probe failed. Empty
          // evidence is recorded only when BOTH required variants completed successfully empty.
          if (hasPrice || (directResult.ok&&anyResult.ok&&direct==null&&any==null)) {
            const recorded = await query(()=>db.rpc('collection_record_route_observation',{...store.args(),p_pass_id:job.id,
              p_origin:route.origin,p_dest:route.dest,p_month:month,p_horizon:plan.months,
              p_has_price:hasPrice,p_is_expansion:expansion.has(route.dest)}),unitEnd,{retry:true,op:'collection_record_route_observation'});
            if(recorded!==true)throw new Error('Route price-health observation was not acknowledged');
          }
          const mandatoryComplete=directResult.ok&&anyResult.ok;
          const outcome=mandatoryComplete?(hasPrice?'confirmedPrice':'confirmedEmpty'):'unresolved';
          const outcomes={...cp.outcomes};
          if(retrying){
            cp.retryAttempts=(cp.retryAttempts??0)+1;
            if(mandatoryComplete){
              outcomes.unresolved=Math.max(0,(outcomes.unresolved??0)-1);outcomes[outcome]=(outcomes[outcome]??0)+1;
              cp.unresolvedCells=cp.unresolvedCells.filter(id=>id!==cellId);
            }else cp.retryNext.push(cellId);
            cp={...cp,outcomes,errors:cp.errors+Number(!directResult.ok)+Number(!anyResult.ok),retryCursor:cp.retryCursor+1};
            if(cp.retryCursor>=cp.retryQueue.length){
              cp.retryRound=(cp.retryRound??0)+1;
              const remaining=[...cp.retryNext];delete cp.retryQueue;delete cp.retryCursor;delete cp.retryNext;
              cp.unresolvedCells=remaining;
              // A retry round is deliberately a separate bounded scheduler attempt. With the
              // current one-round policy, unresolved cells remain explicit and the attempted pass
              // can close without pretending they are confirmed coverage.
              if(remaining.length&&cp.retryRound<MAIN_MAX_RETRY_ROUNDS){cp.retryQueue=remaining;cp.retryCursor=0;cp.retryNext=[];
                return{status:'yield',checkpoint:cp};}
              break;
            }
          }else{
            outcomes.attempted=(outcomes.attempted??0)+1;outcomes[outcome]=(outcomes[outcome]??0)+1;
            cp={...cp,outcomes,cursor:cp.cursor+1,errors:cp.errors+Number(!directResult.ok)+Number(!anyResult.ok),total,
              ...(mandatoryComplete?{}:{unresolvedCells:[...cp.unresolvedCells,cellId]})};
            if(cp.cursor===total&&cp.unresolvedCells.length&&(cp.retryRound??0)<MAIN_MAX_RETRY_ROUNDS){
              cp.retryQueue=[...cp.unresolvedCells];cp.retryCursor=0;cp.retryNext=[];
              return{status:'yield',checkpoint:cp};
            }
          }
        }
        if (cp.cursor===total&&(!Array.isArray(cp.retryQueue)||cp.retryCursor>=cp.retryQueue.length)) {
          // Preserve a private CSV of actual confirmed observations. Failed
          // cells retain old prices and are excluded by the observation cutoff.
          const rows=await load('prices','origin,market,dest,month,direct,any_stops,updated_at',PRICE_ORDER,
            q=>q.in('month',plan.months).gte('updated_at',new Date(job.startedAt).toISOString()),unitEnd);
          const selected=new Set(plan.routes.map(r=>r.key));
          const csv=['origin,market,dest,depart_month,price_direct,price_any,currency,fetched_at,scope',...rows.filter(r=>selected.has(r.origin+'|'+r.dest))
            .map(r=>[r.origin,r.market,r.dest,r.month,r.direct??'',r.any_stops??'','EUR',r.updated_at,`coordinator-${job.id}`].join(','))].join('\n')+'\n';
          const date=job.planDate;
          const hhmm=new Date(job.startedAt).toLocaleTimeString('en-GB',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hour12:false}).replace(':','');
          const path=`snapshots/${date.slice(0,4)}/${date.slice(5,7)}/${date}_${hhmm}_coordinator-${job.id}.csv.gz`;
          const body=gzipSync(csv);
          await query(()=>db.storage.from('price-snapshots').upload(path,body,{contentType:'application/gzip',upsert:true}),unitEnd,{retry:true,op:'price_snapshot_upload'});
          // The pass is complete once its private CSV is preserved. Daily selection remains the
          // coordinator pre-phase and is never coupled to MAIN completion.
          const coverageComplete=(cp.outcomes.suspended??0)===0&&(cp.outcomes.legacyUnclassified??0)===0&&(cp.outcomes.unresolved??0)===0
            &&(cp.outcomes.confirmedPrice??0)+(cp.outcomes.confirmedEmpty??0)===total;
          return {status:'done',checkpoint:{...cp,stage:coverageComplete?'complete':'attempted_complete',coverageComplete,snapshotPath:path}};
        }
        return { status:'progress',checkpoint:cp };
      } catch (error) {
        if (error instanceof CollectionYield) return { status:'yield',checkpoint:cp };
        throw error;
      }
    },
  };

  async function persistExactOutcome(ticket,response,outcome,deadline) {
    const now = new Date(clock()).toISOString(); const market = marketForOrigin(ticket.origin);
    let fare = null; let miss = null;
    if (outcome.status==='found') {
      const source = response.json.data.find(r=>r.departure_at?.slice(0,10)===ticket.departure_at && r.return_at?.slice(0,10)===ticket.return_at && Math.round(r.price)===outcome.price && (ticket.flight_type!=='direct'||r.transfers===0));
      fare=withPriceProvenance([{ ...ticket,market,price:outcome.price,
        transfers:Number.isInteger(source?.transfers)?source.transfers:null,airline:typeof source?.airline==='string'?source.airline:null,updated_at:now }],'window_prices')[0];
    } else {
      miss={ origin:ticket.origin,dest:ticket.dest,market,flight_type:ticket.flight_type,
        departure_at:ticket.departure_at,return_at:ticket.return_at,window_kind:ticket.window_kind,
        outcome:outcome.status==='no_result'?'empty':'http_error',detail:outcome.detail,checked_at:now };
    }
    if(ticket.snapshot_at&&ticket.position&&ticket.destination_id){const candidateResult=fare?{status:'found',price:fare.price,
      transfers:fare.transfers,airline:fare.airline,updated_at:fare.updated_at,checked_at:fare.updated_at,
      price_source:preserveCarouselSixMonthMinimum(fare.price_source,ticket.price_source)}
      :{status:outcome.status,detail:outcome.detail};
      await commit('collection_commit_window_candidate',{p_ticket:ticket,p_result:candidateResult},deadline);
    }else await commit('collection_commit_window',{p_fare:fare,p_miss:miss},deadline);
    if(fare){const revived=await query(()=>db.rpc('collection_revive_route',{...store.args(),p_origin:ticket.origin,p_dest:ticket.dest,
      p_observed_at:now}),deadline,{retry:true,op:'collection_revive_route'});if(revived!==true)throw new Error('Route revival was not acknowledged');}
    return outcome.status!=='error';
  }

  async function exact(ticket, deadline) {
    const params = new URLSearchParams({ origin:ticket.origin,destination:ticket.dest,
      departure_at:ticket.departure_at,return_at:ticket.return_at,direct:String(ticket.flight_type==='direct'),
      market:marketForOrigin(ticket.origin),currency:'eur',one_way:'false',limit:'500' });
    const response = await provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?'+params,deadline-9000);
    const outcome = response.kind==='ok' ? classifyResponse(response.json,{
      origin:ticket.origin,dest:ticket.dest,depart:ticket.departure_at,ret:ticket.return_at,mode:ticket.flight_type,
    }) : {status:'error',detail:response.kind==='refused'?'provider_refused':'provider_error'};
    return persistExactOutcome(ticket,response,outcome,deadline);
  }

  async function exactGroup(tickets,deadline){
    if(!tickets.length)return true;const ticket=tickets[0];
    const params=new URLSearchParams({origin:ticket.origin,destination:ticket.dest,departure_at:ticket.departure_at,
      return_at:ticket.return_at,direct:'false',market:marketForOrigin(ticket.origin),currency:'eur',one_way:'false',limit:'500'});
    const response=await provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?'+params,deadline-9000);
    let ok=true;for(const member of tickets){const outcome=response.kind==='ok'?classifyResponse(response.json,{origin:member.origin,dest:member.dest,
      depart:member.departure_at,ret:member.return_at,mode:member.flight_type}):{status:'error',detail:response.kind==='refused'?'provider_refused':'provider_error'};
      ok=(await persistExactOutcome(member,response,outcome,deadline))&&ok;}return ok;
  }

  async function windowWasRefreshedRecently(ticket,deadline){
    const rows=await query(()=>db.from('window_prices').select('updated_at').eq('origin',ticket.origin).eq('dest',ticket.dest)
      .eq('flight_type',ticket.flight_type).eq('departure_at',ticket.departure_at).eq('return_at',ticket.return_at)
      .gte('updated_at',new Date(clock()-30*60*1000).toISOString()).limit(1),deadline,{retry:true,op:'window_prices_freshness_check'});
    recordRead('window_prices',rows);
    return rows?.length>0;
  }

  function windowAdapter(task) {
    return { maxUnitMs:45_000, async step({job,deadline}) {
      const unitEnd=Math.min(deadline,clock()+30000); let cp=job.checkpoint??{cursor:0,errors:0,wave};
      const pinnedWave=cp.wave??wave;cp={...cp,wave:pinnedWave};
      try {
        const plan=await durablePlan(task,{...job,checkpoint:cp},async()=>{
          const history=await load('window_prices','origin,dest,flight_type,departure_at,return_at,price,window_kind',WINDOW_ORDER,q=>q.gte('departure_at',job.planDate),unitEnd);
          const watchRows=await watches(unitEnd);
          if(task==='fast')return fastPlan({rows:history,watches:watchRows,today:job.planDate,wave:pinnedWave});
          const holidays=await load('public_holidays','country,subdivision_code,level,date',['country','subdivision_code','date'],undefined,unitEnd);
          const regions=await load('origin_regions','airport,calendar_subdivision_code',['airport'],undefined,unitEnd);
          const windows=computeAllWindows(holidays,[...new Set(regions.map(r=>r.calendar_subdivision_code).filter(Boolean))],job.planDate);
          return tailPlan({date:job.planDate,wave:pinnedWave,windows,history,watches:watchRows});
        });
        const total=task==='fast'?plan.tickets.length:plan.routes.length*plan.windows.length*2;
        while(cp.cursor<total&&clock()+19000<unitEnd){
          let ticket;
          if(task==='fast')ticket=plan.tickets[cp.cursor];
          else {
            const route=plan.routes[Math.floor(cp.cursor/(plan.windows.length*2))];
            const window=plan.windows[Math.floor(cp.cursor/2)%plan.windows.length];
            ticket={...route,departure_at:window.start,return_at:window.end,nights:window.nights,
              window_kind:window.kind,flight_type:cp.cursor%2===0?'direct':'any'};
          }
          // Priority owns 30-minute freshness for every existing consumer row. FAST and TAIL keep
          if(isSuspendedOrigin(ticket.origin)){
            if(!await store.lease())throw new Error('Suspended window advancement forbidden: lease lost');
            cp={...cp,cursor:cp.cursor+1,total,suspended:(cp.suspended??0)+1};continue;
          }
          // discovery/watch duties but do not issue a duplicate TP request for an exact key that
          // priority (or another exact writer) already refreshed inside the cadence window.
          if(await windowWasRefreshedRecently(ticket,unitEnd)){
            cp={...cp,cursor:cp.cursor+1,total,reusedPriority:(cp.reusedPriority??0)+1};continue;
          }
          const recent=getState()?.jobs?.fast;
          if(task==='tail'&&recent&&clock()-recent.startedAt<7200000&&recent.checkpoint?.confirmed?.includes(exactKey(ticket))){
            cp={...cp,cursor:cp.cursor+1,total,reusedFast:(cp.reusedFast??0)+1};continue;
          }
          const ok=await exact(ticket,unitEnd);
          cp={...cp,cursor:cp.cursor+1,errors:cp.errors+(ok?0:1),total,
            ...(task==='fast'&&ok?{confirmed:[...(cp.confirmed??[]),exactKey(ticket)]}:{})};
        }
        return {status:cp.cursor===total?'done':'progress',checkpoint:cp};
      }catch(error){if(error instanceof CollectionYield)return{status:'yield',checkpoint:cp};throw error;}
    }};
  }

  const berlinDay = now => new Date(now).toLocaleDateString('en-CA',{timeZone:'Europe/Berlin'});

  // The only owner of TP priority work. A checkpointed 30-minute cycle always executes in this
  // order: one exact feedback claim, the complete saved roulette pool, then the durable saved-window
  // cursor. Every request uses the same provider and fenced lease. Window membership remains a
  // separately blocked product/app contract; the scheduler never invents a top-N cap.
  const priority={maxUnitMs:PRIORITY_UNIT_MAX_MS,async step({job,deadline}){
    const previous=structuredClone(job.checkpoint??{});const now=clock();const today=berlinDay(now);
    const previousDueAt=Number.isFinite(previous.dueAt)?previous.dueAt:Number.isFinite(job.startedAt)?job.startedAt:now;
    const previousRoulette=previous.roulette??null;
    const pendingRoulette=previousRoulette&&!previousRoulette.done?previousRoulette:null;
    const cp=previous.cycle===job.id?previous:{...previous,cycle:job.id,dueAt:job.id*30*60*1000,
      phase:'audit',auditDone:false,auditProcessed:0,
      roulette:pendingRoulette?{...pendingRoulette,resumedInCycle:job.id,
        admittedAt:Number.isFinite(pendingRoulette.admittedAt)?pendingRoulette.admittedAt:
          Number.isFinite(pendingRoulette.dueAt)?pendingRoulette.dueAt:previousDueAt}:{cycle:job.id,cursor:0,errors:0,done:false,
        admittedAt:job.id*30*60*1000,
        technicalDeferred:structuredClone(previousRoulette?.technicalDeferred??[]),
        technicalOutcomes:structuredClone(previousRoulette?.technicalOutcomes??[])}};
    if(cp.roulette&&!cp.roulette.done&&!Number.isFinite(cp.roulette.admittedAt))
      cp.roulette.admittedAt=Number.isFinite(cp.roulette.dueAt)?cp.roulette.dueAt:previousDueAt;
    deadline=Math.min(deadline,clock()+PRIORITY_UNIT_MAX_MS);
    try {
      if(cp.phase==='audit'){
        const audit=await claimAndFinishOneAudit(deadline,today);
        if(audit.claimed){
          if(Number.isFinite(audit.queuedAt))cp.auditOldestWaitMs=Math.max(cp.auditOldestWaitMs??0,now-audit.queuedAt);
          cp.auditProcessed=(cp.auditProcessed??0)+1;
          if(cp.auditProcessed>=PRIORITY_AUDIT_BATCH){cp.auditDone=true;cp.phase='roulette';}
          return{status:'progress',checkpoint:cp};
        }
        cp.auditDone=true;cp.phase='roulette';
      }
      if(cp.phase==='roulette'){
        const r=cp.roulette;
        const latest=await query(()=>db.from('daily_origin_cheapest_pool').select('snapshot_at').order('snapshot_at',{ascending:false}).limit(1),deadline,{retry:true,op:'daily_origin_cheapest_pool_latest_snapshot'});
        recordRead('daily_origin_cheapest_pool',latest);
        const latestSnapshot=latest[0]?.snapshot_at??null;
        // Once admitted, a sub-pass owns one immutable snapshot and cadence instant until its
        // cursor genuinely reaches total. A later scheduler cycle may observe a newer snapshot,
        // but it must finish this admitted set before a future pass can adopt that snapshot.
        if(!Object.hasOwn(r,'snapshotAt')){r.snapshotAt=latestSnapshot;r.cursor=0;r.errors=0;r.done=false;r.technicalDeferred=[];}
        const admittedSnapshot=r.snapshotAt;
        const snapshotId=String(Math.max(0,Date.parse(admittedSnapshot??'')||0));
        // Keyed only by snapshot (not r.cycle): the plan is a daily artifact, built once per
        // snapshot and reused for every 30-minute cycle until the snapshot changes (see the
        // snapshotAt reset above). Previously keying on r.cycle rebuilt this every cycle and
        // re-read the pool each time. Membership is immutable; refresh never needs an alternative-
        // city offers query.
        const plan=await store.plan(`coordinator/roulette-${snapshotId}-0.json`,async()=>{
          if(!admittedSnapshot)return{tickets:[],snapshotAt:null};
          const tickets=await load('daily_origin_cheapest_pool','observed_on,snapshot_at,origin,dest,flight_type,departure_at,return_at,rank,price,transfers,market,source_updated_at,price_source',
            ['origin','flight_type','rank'],q=>q.eq('snapshot_at',admittedSnapshot),deadline);
          if(tickets.length>220)throw new Error(`Roulette pool exceeds 22 origins × 10 tickets (${tickets.length}>220)`);
          const eligible=tickets.filter(t=>t.departure_at>=today&&t.return_at>t.departure_at);
          return{tickets:eligible,snapshotAt:admittedSnapshot};
        });
        // PILOT (off by default): the full daily pool/plan is cached and left
        // exactly as-is (membership/rank/dest never depend on time of day); only which of THIS
        // cycle's tickets get a price re-confirmation is narrowed by market-local time of day.
        // Filtered here (not inside store.plan's cached builder) so the cache stays the full,
        // stable daily set and this filter is always re-evaluated fresh every cycle.
        const effectiveTickets=pilotMarketSchedule?plan.tickets.filter(t=>originDueThisCycle(r.admittedAt,t.origin)):plan.tickets;
        const ticketPayload=ticket=>({...ticket,month:ticket.departure_at.slice(0,7),run_id:store.runId});
        const safeToken=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(value)?value:undefined;
        const safeDiagnostic=(response,outcome,error)=>({
          ...(safeToken(response?.kind)?{providerKind:safeToken(response.kind)}:{}),
          ...(Number.isInteger(response?.status)&&response.status>=100&&response.status<=599?{httpStatus:response.status}:{}),
          ...(safeToken(response?.refusal)?{refusal:safeToken(response.refusal)}:{}),
          ...(safeToken(outcome?.detail)?{classifierDetail:safeToken(outcome.detail)}:{}),
          ...(safeToken(error?.dbCode)?{storageCode:safeToken(error.dbCode)}:{}),
        });
        const ticketIdentity=ticket=>({origin:ticket.origin,dest:ticket.dest,flight_type:ticket.flight_type,
          departure_at:ticket.departure_at,return_at:ticket.return_at,rank:ticket.rank,snapshot_at:ticket.snapshot_at});
        const recordTechnicalOutcome=(ticket,outcome)=>{const key=exactKey(ticket);
          const deferred=(r.technicalDeferred??[]).find(item=>item.key===key);if(!deferred)return;
          r.technicalDeferred=r.technicalDeferred.filter(item=>item.key!==key);
          const result={key,outcome,cycle:cp.cycle};
          r.technicalOutcomes=[...(r.technicalOutcomes??[]).filter(item=>item.key!==key),result].slice(-220);
        };
        const deferTechnical=(ticket,{response=null,outcome=null,error=null}={})=>{const key=exactKey(ticket);
          const old=(r.technicalDeferred??[]).find(item=>item.key===key);
          const item={key,stage:'ticket',outcome:'technical_failure',cycle:cp.cycle,firstCycle:old?.firstCycle??old?.cycle??cp.cycle,
            attempts:(old?.attempts??0)+1,ticket:ticketIdentity(ticket),...safeDiagnostic(response,outcome,error)};
          r.errors++;r.technicalDeferred=[...(r.technicalDeferred??[]).filter(entry=>entry.key!==key),item];
          r.cursor++;};
        const ticket=effectiveTickets[r.cursor];
        if(ticket && isSuspendedOrigin(ticket.origin)){
          r.suspended=(r.suspended??0)+1;r.cursor++;
        } else if(ticket){
          const params=new URLSearchParams({origin:ticket.origin,destination:ticket.dest,departure_at:ticket.departure_at,return_at:ticket.return_at,
            direct:String(ticket.flight_type==='direct'),market:marketForOrigin(ticket.origin),currency:'eur',one_way:'false',limit:'500'});
          const response=await provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?'+params,deadline-9000);
          const result=response.kind==='ok'?classifyResponse(response.json,{origin:ticket.origin,dest:ticket.dest,depart:ticket.departure_at,ret:ticket.return_at,mode:ticket.flight_type}):{status:'error',detail:'provider_error'};
          const source=Array.isArray(response.json?.data)?response.json.data.find(row=>classifyResponse({success:true,data:[row]},
            {origin:ticket.origin,dest:ticket.dest,depart:ticket.departure_at,ret:ticket.return_at,mode:ticket.flight_type}).price===result.price):undefined;
          const patch=withPriceProvenance([{...result,updated_at:new Date(clock()).toISOString(),market:marketForOrigin(ticket.origin),flight_type:ticket.flight_type,
            transfers:Number.isInteger(source?.transfers)?source.transfers:null,airline:typeof source?.airline==='string'?source.airline:null}],'offers')[0];
          if(result.status==='error')deferTechnical(ticket,{response,outcome:result});
          if(result.status==='no_result'){
            await commit('collection_commit_roulette',{p_ticket:ticketPayload(ticket),p_result:result},deadline);
            recordTechnicalOutcome(ticket,'retained_no_result');r.cursor++;
          }
          if(result.status==='found'){await commit('collection_commit_roulette',{p_ticket:ticketPayload(ticket),p_result:patch},deadline);
            const revived=await query(()=>db.rpc('collection_revive_route',{...store.args(),p_origin:ticket.origin,p_dest:ticket.dest,
            p_observed_at:patch.updated_at}),deadline,{retry:true,op:'collection_revive_route'});if(revived!==true)throw new Error('Route revival was not acknowledged');}
          if(result.status==='found'){recordTechnicalOutcome(ticket,'refreshed');r.cursor++;}
        }
        r.total=effectiveTickets.length;r.done=r.cursor>=r.total;
        cp.phase='weekend';
        return{status:'progress',checkpoint:cp};
      }
      if(cp.phase==='weekend'){
        let w=cp.weekend;
        if(!w||w.done){const dayId=Math.floor(Date.parse(today+'T00:00:00Z')/DAY);w={day:today,dayId,cursor:0,done:false,errors:0,
          passStartedAt:clock(),admittedAt:Number.isFinite(cp.dueAt)?cp.dueAt:now};}
        if(!Number.isFinite(w.admittedAt))w.admittedAt=Number.isFinite(w.dueAt)?w.dueAt:previousDueAt;
        // Latest-row-only: snapshot_at is UNIQUE on this table (see
        // 20260922140000_daily_window_candidates.sql), so desc+limit(1) returns exactly the
        // same row ascending-order .at(-1) used to, without paging the whole epoch history
        // on every weekend-phase tick.
        const epochs=await query(()=>db.from('daily_window_candidate_epochs')
          .select('observed_on,snapshot_at,contract_version,candidate_rows,exact_request_groups')
          .order('snapshot_at',{ascending:false}).limit(1),deadline,{retry:true,op:'daily_window_candidate_epochs_latest'});
        recordRead('daily_window_candidate_epochs',epochs);
        if(!epochs.length){w.blockedReason='no_daily_window_candidate_epoch';w.currentDayComplete=false;w.done=true;cp.weekend=w;cp.phase='done';cp.completedAt=clock();
          return{status:'done',checkpoint:cp};}
        const latestEpoch=epochs[0];
        const epoch=w.snapshotAt?{...latestEpoch,snapshot_at:w.snapshotAt,observed_on:w.sourceObservedOn??w.day}:latestEpoch;
        const epochId=String(Math.max(0,Date.parse(epoch.snapshot_at)||0));
        const currentDayEpoch=epoch.observed_on===w.day;
        if(!w.snapshotAt)w={...w,cursor:0,snapshotAt:epoch.snapshot_at,
          sourceObservedOn:epoch.observed_on,currentDayComplete:currentDayEpoch,
          ...(currentDayEpoch?{}:{blockedReason:'stale_daily_window_candidate_epoch'})};
        else{w.sourceObservedOn=epoch.observed_on;w.currentDayComplete=currentDayEpoch;
          if(currentDayEpoch)delete w.blockedReason;else w.blockedReason='stale_daily_window_candidate_epoch';}
        const plan=await store.plan(`coordinator/windowrefresh-${w.dayId}-${epochId}.json`,async()=>{
          const tickets=await load('daily_window_candidates','observed_on,snapshot_at,origin,market,dest,destination_id,flight_type,departure_at,return_at,position,window_kind,exact_observed_at,refresh_status,price_source',
            ['origin','flight_type','departure_at','return_at','position'],q=>q.eq('snapshot_at',epoch.snapshot_at),deadline);
          const selected=tickets.map(t=>({...t,nights:(Date.parse(t.return_at+'T00:00:00Z')-Date.parse(t.departure_at+'T00:00:00Z'))/DAY,
            updated_at:t.exact_observed_at}));
          return{day:w.day,setId:`daily-window:${epoch.snapshot_at}`,selectedAt:epoch.snapshot_at,tickets:selected,
            groups:groupWindowConsumerTickets(selected)};
        });
        // PILOT (off by default): same principle as roulette above — the cached plan/groups stay
        // the full daily set; only which groups get touched THIS cycle is narrowed by each
        // group's origin's market-local time of day. Every group from one groupWindowConsumerTickets
        // bucket shares one origin (grouped by [origin,dest,departure_at,return_at]).
        const effectiveGroups=pilotMarketSchedule?plan.groups.filter(g=>originDueThisCycle(w.admittedAt,g[0].origin)):plan.groups;
        w.setId=plan.setId;w.total=effectiveGroups.length;w.totalRows=plan.tickets.length;w.sourceSelectedAt=plan.selectedAt;
        const group=effectiveGroups[w.cursor];
        if(group){
          if(isSuspendedOrigin(group[0].origin)){w.cursor++;w.suspended=(w.suspended??0)+group.length;}
          else if(group[0].departure_at<today){w.cursor++;w.expired=(w.expired??0)+group.length;}
          else{const age=Math.max(...group.map(ticket=>Math.max(0,clock()-Date.parse(ticket.updated_at))).filter(Number.isFinite));
            const ok=await exactGroup(group,deadline);w.cursor++;w.errors+=ok?0:1;
            w.oldestAgeMs=Math.max(w.oldestAgeMs??0,Number.isFinite(age)?age:0);w.lastRefreshedAt=clock();}
        }
        w.done=w.cursor>=w.total;cp.weekend=w;
        if(w.done){w.passCompletedAt=clock();w.fullCycleMs=w.passCompletedAt-w.passStartedAt;cp.phase='done';cp.completedAt=clock();cp.lagMs=Math.max(0,cp.completedAt-cp.dueAt);return{status:'done',checkpoint:cp};}
        cp.phase=cp.roulette?.done?'weekend':'roulette';return{status:'progress',checkpoint:cp};
      }
      return{status:'done',checkpoint:cp};
    }catch(error){if(error instanceof CollectionYield)return{status:'yield',checkpoint:cp};throw error;}
  }};

  // Nightly maintenance block (owner spec 2026-09-26): due once per Berlin day at 03:00, must
  // settle (or give up for the night) by 05:45 — always well before the 06:00 daily selection —
  // capped at 15 real minutes of work. Replaces the old "one turn every 30-minute cycle, all day"
  // rotation: outside 03:00-05:45 (or once tonight's block is done) this immediately no-ops.
  // isDue lets the scheduling engine give this block precedence over MAIN/FAST/TAIL exactly like
  // priority does (see collection-schedule.mjs) — MAIN yields for the block's whole duration.
  const MAINTENANCE_JOBS = ['app_errors','flight_price_feedback','destination_requests',
    'collect_storage_metrics','plan_bucket_expire','window_prices','price_storage','feedback_audit_drain'];
  async function recursiveSnapshotList(bucket,prefix,deadline){
    if(clock()+9000>=deadline)throw new CollectionYield('Snapshot listing would cross boundary');
    const rows=await query(()=>bucket.list(prefix,{limit:1000,sortBy:{column:'name',order:'asc'}}),deadline,{retry:true,op:'price_storage_snapshot_list'});
    const keys=[];
    for(const item of rows){
      const key=prefix?`${prefix}/${item.name}`:item.name;
      if(item.id||item.metadata)keys.push(key);else keys.push(...await recursiveSnapshotList(bucket,key,deadline));
    }
    return keys;
  }
  const maintenance={maxUnitMs:45000,
    isDue:(instant,checkpoint)=>maintenanceDue(instant,checkpoint),
    async step({job,deadline}){
    const stepStarted=clock();
    const cp=structuredClone(job.checkpoint??{day:null,checked:{},attempted:{},failed:{},summary:[],blockDone:false});
    cp.checked??={};cp.attempted??={};cp.failed??={};cp.summary??=[];
    const now=clock();const today=berlinDay(now);
    if(cp.day!==today){cp.day=today;cp.checked={};cp.attempted={};cp.failed={};cp.summary=[];cp.blockDone=false;}
    // Outside 03:00-05:45 Berlin, or tonight's block already settled: cheap no-op, no DB calls.
    // This is what replaces the old "one turn every 30-minute cycle, all day" rotation.
    if(!maintenanceDue(now,cp))return{status:'empty',checkpoint:cp};
    const elapsedMs=job.activeMs??0;
    if(maintenanceMustStop(now,elapsedMs)){
      cp.blockDone=true;
      console.log(JSON.stringify({event:'maintenance_block',jobs:cp.summary,total_ms:elapsedMs,done:false}));
      return{status:'done',checkpoint:cp};
    }
    deadline=Math.min(deadline,clock()+35000);
    try{
      for(const name of MAINTENANCE_JOBS){
        if(cp.checked[name]===today)continue;
        if(name==='collect_storage_metrics'&&cp.attempted[name]===today)continue;
        if(name==='price_storage'&&!isQuarterlyMaintenanceDay(today)){cp.checked[name]=today;continue;}
        const unitStart=clock();
        let rows=0,done=true;
        if(['app_errors','flight_price_feedback','destination_requests'].includes(name)){
          const cutoff=name==='destination_requests'?calendarMonthsAgoIso(new Date(now)):new Date(now-(name==='app_errors'?90:365)*DAY).toISOString();
          const found=await query(()=>db.from(name).select('id').lt('created_at',cutoff).order('created_at').order('id').limit(100),deadline,{retry:true,op:`${name}_expired_scan`});
          rows=found.length;
          if(rows){await query(()=>db.from(name).delete().in('id',found.map(r=>r.id)),deadline,{retry:true,op:`${name}_expired_delete`});done=false;}
        }else if(name==='collect_storage_metrics'){
          try{
            await query(()=>db.rpc('collect_storage_metrics'),deadline,{op:'collect_storage_metrics'});
            cp.attempted[name]=today;
          }catch(error){
            // This append-only RPC is auxiliary telemetry. A client timeout is ambiguous: the
            // server transaction may still commit, so record one failed attempt for this Berlin
            // day and continue without retrying it. Boundary yields, cancellation, lease/fence
            // loss and every failure from another operation keep their existing semantics.
            if(error?.dbOp!==name)throw error;
            const failure={name,status:'FAILED',code:error.dbCode??'unknown',rows:0,ms:clock()-unitStart};
            cp.attempted[name]=today;
            cp.failed[name]={day:today,code:failure.code};
            cp.summary.push(failure);
            console.log(JSON.stringify({event:'maintenance_result',...failure,day:today}));
            return{status:'progress',checkpoint:cp};
          }
        }else if(name==='plan_bucket_expire'){
          const bucket=db.storage.from('price-snapshots');
          const found=await query(()=>bucket.list('coordinator',{limit:100,sortBy:{column:'created_at',order:'asc'}}),deadline,{retry:true,op:'plan_bucket_list'});
          const state=getState();const protectedNames=new Set(Object.entries(state?.jobs??{}).map(([task,j])=>`${task}-${j.id}-${j.checkpoint?.wave??wave}.json`));
          const p=state?.jobs?.priority?.checkpoint;if(p?.roulette)protectedNames.add(`roulette-${p.roulette.cycle}-0.json`);if(p?.weekend)protectedNames.add(`windowrefresh-${p.weekend.dayId}-0.json`);
          const expired=found.filter(r=>/^(main|tail|fast|roulette|windowrefresh)-\d+-\d+\.json$/.test(r.name)&&!protectedNames.has(r.name)&&Date.parse(r.created_at)<now-35*DAY).map(r=>'coordinator/'+r.name);
          rows=expired.length;
          if(rows){await query(()=>bucket.remove(expired),deadline,{retry:true,op:'plan_bucket_remove_expired'});done=false;}
        }else if(name==='window_prices'){
          // Ported from cleanup-window-prices.mjs (the standalone workflow no longer runs on its
          // own schedule under coordinated mode — see .github/workflows/cleanup-window-prices.yml).
          const found=await query(()=>db.from('window_prices').select('departure_at').lt('departure_at',today)
            .order('departure_at',{ascending:true}).limit(500),deadline,{retry:true,op:'window_prices_expired_scan'});
          rows=found.length;
          if(rows){const watermark=found.at(-1).departure_at;
            await query(()=>db.from('window_prices').delete().lt('departure_at',today).lte('departure_at',watermark),deadline,{retry:true,op:'window_prices_expired_delete'});
            done=rows<500;}
        }else if(name==='price_storage'){
          // Ported from cleanup-price-storage.mjs (quarterly; gated above to only the standalone
          // workflow's own due day — 1st of Jan/Apr/Jul/Oct, Berlin).
          const progressCutoff=retentionCutoff(today,positiveDays(process.env.PROGRESS_RETENTION_DAYS,PROGRESS_RETENTION_DAYS));
          const foundProgress=await query(()=>db.from('window_price_progress').select('plan_date').lt('plan_date',progressCutoff)
            .order('plan_date',{ascending:true}).limit(500),deadline,{retry:true,op:'price_storage_progress_scan'});
          if(foundProgress.length){const watermark=foundProgress.at(-1).plan_date;
            await query(()=>db.from('window_price_progress').delete().lt('plan_date',progressCutoff).lte('plan_date',watermark),deadline,{retry:true,op:'price_storage_progress_delete'});
            rows=foundProgress.length;done=foundProgress.length<500;
          }else{
            const snapshotCutoff=retentionCutoff(today,positiveDays(process.env.SNAPSHOT_RETENTION_DAYS,SNAPSHOT_RETENTION_DAYS));
            const bucket=db.storage.from('price-snapshots');
            const objects=await recursiveSnapshotList(bucket,'snapshots',deadline);
            const expired=objects.filter(key=>shouldDeleteSnapshot(key,snapshotCutoff));
            rows=expired.length;
            for(let i=0;i<expired.length;i+=100)await query(()=>bucket.remove(expired.slice(i,i+100)),deadline,{retry:true,op:'price_storage_snapshot_remove'});
          }
        }else if(name==='feedback_audit_drain'){
          const audit=await claimAndFinishOneAudit(deadline,today);
          rows=audit.claimed?1:0;done=!audit.claimed;
        }
        cp.summary.push({name,rows,ms:clock()-unitStart,...(name==='collect_storage_metrics'?{status:'SUCCESS'}:{})});
        if(!done)return{status:'progress',checkpoint:cp};
        cp.checked[name]=today;
        if(name!==MAINTENANCE_JOBS.at(-1))return{status:'progress',checkpoint:cp};
        break;
      }
      cp.blockDone=true;
      console.log(JSON.stringify({event:'maintenance_block',jobs:cp.summary,
        total_ms:(job.activeMs??0)+Math.max(0,clock()-stepStarted),done:true}));
      return{status:'done',checkpoint:cp};
    }catch(error){if(error instanceof CollectionYield)return{status:'yield',checkpoint:cp};throw error;}
  }};
  return{priority,main,fast:windowAdapter('fast'),tail:windowAdapter('tail'),maintenance};
}
