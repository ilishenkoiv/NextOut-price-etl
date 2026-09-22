import { probeType, fetchCalendarMonth, selectCombo } from './fetch-prices.mjs';
import { monthlyQuoteProvenance } from './quote-integrity.mjs';
import { withPriceProvenance } from './price-provenance.mjs';
import { marketForOrigin } from '../src/data/origin-markets.js';
import { mainPlan, tailPlan, fastPlan, nextMonth, horizon, resolveTrancheDests, catalogue } from './collection-planning.mjs';
import { computeAllWindows } from './collection-windows.mjs';
import { buildBreakWindows } from './break-windows.mjs';
import { CollectionYield } from './collection-provider.mjs';
import { withSupabaseRetry } from './supabase-retry.mjs';
import { classifyResponse, ticketFromFeedback } from './check-flight-price-feedback.mjs';
import { calendarMonthsAgoIso } from './destination-request-retention.mjs';
import { expansionTargets } from '../src/data/expansion-targets.js';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const PRICE_ORDER = ['origin','dest','month'];
const WINDOW_ORDER = ['origin','dest','flight_type','departure_at','return_at'];
const DAY = 86400000;
export const PRIORITY_AUDIT_BATCH = 10;
export const MAIN_REQUIRED_PROVIDER_CALLS = 4;
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
export function buildRouletteReplacementCandidates(offers,pool,allowedDests,today){const allowed=new Set(allowedDests),used=new Set(pool.map(t=>`${t.origin}|${t.dest}`)),best=new Map();
  for(const row of offers){if(!allowed.has(row.dest)||used.has(`${row.origin}|${row.dest}`)||row.departure_at<today||!row.return_at||row.return_at<=row.departure_at||!(Number(row.price)>0))continue;
    const key=`${row.origin}|${row.flight_type}|${row.dest}`,old=best.get(key);if(!old||Number(row.price)<Number(old.price)||Number(row.price)===Number(old.price)&&String(row.updated_at).localeCompare(String(old.updated_at))>0)best.set(key,row);}
  const grouped={};for(const row of best.values())(grouped[`${row.origin}|${row.flight_type}`]??=[]).push(row);for(const rows of Object.values(grouped))rows.sort((a,b)=>Number(a.price)-Number(b.price)
    ||String(b.updated_at).localeCompare(String(a.updated_at))||Number(a.transfers??0)-Number(b.transfers??0)||String(a.departure_at).localeCompare(String(b.departure_at))||String(a.dest).localeCompare(String(b.dest)));
  return grouped;}

export function createAdapters({ db, store, provider, wave = 0, clock = Date.now, setDbDeadline = () => {}, getState = () => null,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random }) {
  const exactKey=t=>[t.origin,t.dest,t.flight_type,t.departure_at,t.return_at].join('|');
  // Bound the transient-retry backoff so no attempt (retry wait + one ~8s request +
  // the 9s boundary guard) can run past the unit/session deadline. If nothing fits,
  // delays is empty and the operation runs exactly once, failing honestly.
  function retryBudget(deadline) {
    const base = [1000, 3000, 8000]; const delays = []; let projected = clock();
    for (const d of base) { projected += d + 8000; if (projected + 9000 > deadline) break; delays.push(d); }
    return { label: 'coordinator db', delays, sleep, random, now: clock, warn: () => {} };
  }
  // A retry rebuilds a fresh PostgREST builder via `build` and re-checks the fenced
  // lease before every attempt. Only reads and PROVEN-idempotent writes pass retry:true;
  // permanent Postgres/RLS/schema errors are non-transient and surface unchanged, so a
  // failed operation never becomes a false success and never masks a real error.
  async function query(build, deadline = Infinity, { retry = false } = {}) {
    if (clock() + 9000 >= deadline) throw new CollectionYield('Database unit would cross boundary');
    const attempt = async () => {
      if (!await store.lease()) throw new Error('Database operation forbidden: lease lost');
      return build();
    };
    const result = retry ? await withSupabaseRetry(attempt, retryBudget(deadline)) : await attempt();
    if (result.error) throw new Error(`Collection database operation failed (${result.error.code ?? 'unknown'})`);
    return result.data;
  }
  async function load(table, columns, order, apply = q => q, deadline = Infinity) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const data = await query(() => {
        let q = db.from(table).select(columns); for (const key of order) q = q.order(key);
        return apply(q).range(from, from + 999);
      }, deadline, { retry: true });
      rows.push(...data); if (data.length < 1000) return rows;
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
    const accepted=await query(() => db.rpc(name, { ...store.args(), ...payload }), deadline, { retry: true });
    if(accepted!==true)throw new Error('Collection write was not acknowledged');
    return accepted;
  }

  const main = {
    // Main no longer publishes the roulette pool. Selection is owned exclusively by the
    // nightly `Nightly cheapest offers selection` workflow (scripts/snapshot-daily-origin-cheapest.mjs);
    // the main pass only refreshes source offers and completes. No 480s snapshot unit needed.
    // Four mandatory upstream calls (two return windows × direct/any) need more than the former
    // 30s unit at the 8s timeout. 75s work / 90s admission preserves the boundary guard.
    maxUnitMs: 90_000,
    async step({ job, deadline }) {
      const unitEnd = Math.min(deadline, clock() + 75_000);
      let cp = job.checkpoint ?? { cursor: 0, errors: 0, wave };
      const pinnedWave=cp.wave??wave;
      cp={...cp,wave:pinnedWave};
      try {
        const plan = await durablePlan('main',{...job,checkpoint:cp},async () => {
          const months = horizon(job.planDate);
          const prices = await load('prices','origin,dest,month,direct,any_stops',PRICE_ORDER,q=>q.in('month',months),unitEnd);
          const routeHealth = await load('route_price_health','origin,dest,status',['origin','dest'],undefined,unitEnd);
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
        // A cursor is advanced only after the complete cell has been committed.
        while (cp.cursor < total && clock() + 15000 < unitEnd) {
          const cellId = plan.cellOrder ? plan.cellOrder[cp.cursor] : cp.cursor;
          const route = plan.routes[cellId % plan.routes.length];
          const month = plan.months[Math.floor(cellId / plan.routes.length)];
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
              p_has_price:hasPrice,p_is_expansion:expansion.has(route.dest)}),unitEnd,{retry:true});
            if(recorded!==true)throw new Error('Route price-health observation was not acknowledged');
          }
          cp = { ...cp, cursor:cp.cursor+1, errors:cp.errors+Number(!directResult.ok)+Number(!anyResult.ok), total };
        }
        if (cp.cursor===total) {
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
          await query(()=>db.storage.from('price-snapshots').upload(path,body,{contentType:'application/gzip',upsert:true}),unitEnd,{retry:true});
          // The pass is complete once its private CSV is preserved. Selection (roulette pool
          // membership/order/rank) is NOT done here — it is the nightly selection owner's job.
          return {status:'done',checkpoint:{...cp,stage:'complete',snapshotPath:path}};
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
      transfers:fare.transfers,airline:fare.airline,updated_at:fare.updated_at,checked_at:fare.updated_at,price_source:fare.price_source}
      :{status:outcome.status,detail:outcome.detail};
      await commit('collection_commit_window_candidate',{p_ticket:ticket,p_result:candidateResult},deadline);
    }else await commit('collection_commit_window',{p_fare:fare,p_miss:miss},deadline);
    if(fare){const revived=await query(()=>db.rpc('collection_revive_route',{...store.args(),p_origin:ticket.origin,p_dest:ticket.dest,
      p_observed_at:now}),deadline,{retry:true});if(revived!==true)throw new Error('Route revival was not acknowledged');}
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
      .gte('updated_at',new Date(clock()-30*60*1000).toISOString()).limit(1),deadline,{retry:true});
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
  const priority={maxUnitMs:45000,async step({job,deadline}){
    const previous=structuredClone(job.checkpoint??{});const now=clock();const today=berlinDay(now);
    const pendingRoulette=previous.roulette&&!previous.roulette.done?previous.roulette:null;
    const cp=previous.cycle===job.id?previous:{...previous,cycle:job.id,dueAt:job.id*30*60*1000,
      phase:'audit',auditDone:false,auditProcessed:0,
      roulette:pendingRoulette?{...pendingRoulette,resumedInCycle:job.id}:{cycle:job.id,cursor:0,errors:0,done:false}};
    deadline=Math.min(deadline,clock()+35000);
    try {
      if(cp.phase==='audit'){
        const rows=await query(()=>db.rpc('claim_flight_price_audit'),deadline);
        const row=rows?.[0];
        if(row){
          const queuedAt=Date.parse(row.created_at??row.feedback?.created_at);
          if(Number.isFinite(queuedAt))cp.auditOldestWaitMs=Math.max(cp.auditOldestWaitMs??0,now-queuedAt);
          const ticket=ticketFromFeedback(row.feedback,today);let outcome={status:'not_requested',detail:'missing_exact_context'};
          if(ticket){
            const params=new URLSearchParams({origin:ticket.origin,destination:ticket.dest,departure_at:ticket.depart,return_at:ticket.ret,
              direct:String(ticket.mode==='direct'),market:marketForOrigin(ticket.origin),currency:'eur',one_way:'false',limit:'500'});
            const response=await provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?'+params,deadline-9000);
            outcome=response.kind==='ok'?classifyResponse(response.json,ticket):{status:'error',detail:'provider_error'};
          }
          const result=await query(()=>db.rpc('finish_flight_price_audit',{p_feedback_id:row.feedback_id,p_claim_token:row.claim_token,
            p_status:outcome.status,p_price:outcome.price??null,p_detail:outcome.detail,p_run_id:store.runId}),deadline);
          if(result!==true)throw new Error('Audit claim expired before completion');
          cp.auditProcessed=(cp.auditProcessed??0)+1;
          if(cp.auditProcessed>=PRIORITY_AUDIT_BATCH){cp.auditDone=true;cp.phase='roulette';}
          return{status:'progress',checkpoint:cp};
        }
        cp.auditDone=true;cp.phase='roulette';
      }
      if(cp.phase==='roulette'){
        const r=cp.roulette;
        const plan=await store.plan(`coordinator/roulette-${r.cycle}-0.json`,async()=>{
          const latest=await query(()=>db.from('daily_origin_cheapest_pool').select('snapshot_at').order('snapshot_at',{ascending:false}).limit(1),deadline,{retry:true});
          if(!latest.length)return{tickets:[]};
          const tickets=await load('daily_origin_cheapest_pool','observed_on,snapshot_at,origin,dest,flight_type,departure_at,return_at,rank,price,transfers,market,source_updated_at,price_source',
            ['origin','flight_type','rank'],q=>q.eq('snapshot_at',latest[0].snapshot_at),deadline);
          if(tickets.length>220)throw new Error(`Roulette pool exceeds 22 origins × 10 tickets (${tickets.length}>220)`);
          const eligible=tickets.filter(t=>t.departure_at>=today&&t.return_at>t.departure_at);
          const allowedDests=catalogue(Number(process.env.SNAPSHOT_EXPANSION_WAVE??0)).map(item=>item.iata);
          const origins=[...new Set(eligible.map(t=>t.origin))];
          const offers=origins.length?await load('offers','origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,airline,updated_at,price_source',
            ['origin','dest','month','flight_type','departure_at','return_at'],q=>q.in('origin',origins).in('dest',allowedDests)
              .gte('departure_at',today).gte('updated_at',new Date(clock()-36*60*60*1000).toISOString()).gt('price',0),deadline):[];
          return{tickets:eligible,allowedDests,replacements:buildRouletteReplacementCandidates(offers,eligible,allowedDests,today)};
        });
        const ticketPayload=ticket=>({...ticket,month:ticket.departure_at.slice(0,7),allowed_dests:plan.allowedDests,run_id:store.runId});
        const deferTechnical=(ticket,stage)=>{const key=[ticket.origin,ticket.dest,ticket.flight_type,ticket.departure_at,ticket.return_at].join('|');
          r.errors++;r.technicalDeferred=[...(r.technicalDeferred??[]).filter(item=>item.key!==key),{key,stage,cycle:r.cycle}];
          r.cursor++;delete r.pendingReplacement;};
        if(r.pendingReplacement){
          const target=r.pendingReplacement.ticket,candidates=plan.replacements[`${target.origin}|${target.flight_type}`]??[];
          let candidate=candidates[r.pendingReplacement.candidateCursor];
          while(candidate&&(r.usedReplacementDests??[]).includes(`${candidate.origin}|${candidate.dest}`))candidate=candidates[++r.pendingReplacement.candidateCursor];
          if(!candidate){
            await commit('collection_commit_roulette',{p_ticket:ticketPayload(target),p_result:{status:'no_result',replacement:null}},deadline);
            r.cursor++;r.exhausted=(r.exhausted??0)+1;delete r.pendingReplacement;
          }else{
            const params=new URLSearchParams({origin:candidate.origin,destination:candidate.dest,departure_at:candidate.departure_at,
              return_at:candidate.return_at,direct:String(candidate.flight_type==='direct'),market:marketForOrigin(candidate.origin),currency:'eur',one_way:'false',limit:'500'});
            const response=await provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?'+params,deadline-9000);
            const outcome=response.kind==='ok'?classifyResponse(response.json,{origin:candidate.origin,dest:candidate.dest,depart:candidate.departure_at,
              ret:candidate.return_at,mode:candidate.flight_type}):{status:'error',detail:'provider_error'};
            if(outcome.status==='error')deferTechnical(target,'replacement');
            if(outcome.status==='no_result'){r.pendingReplacement.candidateCursor++;return{status:'progress',checkpoint:cp};}
            if(outcome.status==='found'){
              const source=response.json.data.find(row=>classifyResponse({success:true,data:[row]},{origin:candidate.origin,dest:candidate.dest,
                depart:candidate.departure_at,ret:candidate.return_at,mode:candidate.flight_type}).price===outcome.price);
              const replacement=withPriceProvenance([{...candidate,...outcome,price:outcome.price,updated_at:new Date(clock()).toISOString(),
                market:marketForOrigin(candidate.origin),transfers:Number.isInteger(source?.transfers)?source.transfers:candidate.transfers,
                airline:typeof source?.airline==='string'?source.airline:null}],'offers')[0];
              await commit('collection_commit_roulette',{p_ticket:ticketPayload(target),p_result:{status:'no_result',replacement}},deadline);
              const revived=await query(()=>db.rpc('collection_revive_route',{...store.args(),p_origin:candidate.origin,p_dest:candidate.dest,
                p_observed_at:replacement.updated_at}),deadline,{retry:true});if(revived!==true)throw new Error('Replacement route revival was not acknowledged');
              r.usedReplacementDests=[...(r.usedReplacementDests??[]),`${candidate.origin}|${candidate.dest}`];r.cursor++;r.replaced=(r.replaced??0)+1;delete r.pendingReplacement;
            }
          }
          r.total=plan.tickets.length;r.done=r.cursor>=r.total;if(r.done)cp.phase='weekend';
          return{status:'progress',checkpoint:cp};
        }
        const ticket=plan.tickets[r.cursor];
        if(ticket&&!r.pendingReplacement){
          const params=new URLSearchParams({origin:ticket.origin,destination:ticket.dest,departure_at:ticket.departure_at,return_at:ticket.return_at,
            direct:String(ticket.flight_type==='direct'),market:marketForOrigin(ticket.origin),currency:'eur',one_way:'false',limit:'500'});
          const response=await provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?'+params,deadline-9000);
          const result=response.kind==='ok'?classifyResponse(response.json,{origin:ticket.origin,dest:ticket.dest,depart:ticket.departure_at,ret:ticket.return_at,mode:ticket.flight_type}):{status:'error'};
          const source=Array.isArray(response.json?.data)?response.json.data.find(row=>classifyResponse({success:true,data:[row]},
            {origin:ticket.origin,dest:ticket.dest,depart:ticket.departure_at,ret:ticket.return_at,mode:ticket.flight_type}).price===result.price):undefined;
          const patch=withPriceProvenance([{...result,updated_at:new Date(clock()).toISOString(),market:marketForOrigin(ticket.origin),flight_type:ticket.flight_type,
            transfers:Number.isInteger(source?.transfers)?source.transfers:null,airline:typeof source?.airline==='string'?source.airline:null}],'offers')[0];
          if(result.status==='error')deferTechnical(ticket,'ticket');
          if(result.status==='no_result'){r.pendingReplacement={ticket,candidateCursor:0};return{status:'progress',checkpoint:cp};}
          if(result.status==='found'){await commit('collection_commit_roulette',{p_ticket:ticketPayload(ticket),p_result:patch},deadline);
            const revived=await query(()=>db.rpc('collection_revive_route',{...store.args(),p_origin:ticket.origin,p_dest:ticket.dest,
            p_observed_at:patch.updated_at}),deadline,{retry:true});if(revived!==true)throw new Error('Route revival was not acknowledged');}
          if(result.status==='found')r.cursor++;
        }
        r.total=plan.tickets.length;r.done=r.cursor>=r.total;
        if(r.done)cp.phase='weekend';
        return{status:'progress',checkpoint:cp};
      }
      if(cp.phase==='weekend'){
        let w=cp.weekend;
        if(!w||w.done){const dayId=Math.floor(Date.parse(today+'T00:00:00Z')/DAY);w={day:today,dayId,cursor:0,done:false,errors:0,passStartedAt:clock()};}
        const epochs=await load('daily_window_candidate_epochs','observed_on,snapshot_at,contract_version,candidate_rows,exact_request_groups',
          ['snapshot_at'],q=>q,deadline);
        if(!epochs.length){w.blockedReason='no_daily_window_candidate_epoch';w.done=true;cp.weekend=w;cp.phase='done';cp.completedAt=clock();
          return{status:'done',checkpoint:cp};}
        const epoch=epochs.at(-1),epochId=String(epoch.snapshot_at).replace(/[^0-9A-Za-z]/g,'');
        const plan=await store.plan(`coordinator/windowrefresh-${w.dayId}-${epochId}.json`,async()=>{
          const tickets=await load('daily_window_candidates','observed_on,snapshot_at,origin,market,dest,destination_id,flight_type,departure_at,return_at,position,window_kind,exact_observed_at,refresh_status',
            ['origin','flight_type','departure_at','return_at','position'],q=>q.eq('snapshot_at',epoch.snapshot_at),deadline);
          const selected=tickets.map(t=>({...t,nights:(Date.parse(t.return_at+'T00:00:00Z')-Date.parse(t.departure_at+'T00:00:00Z'))/DAY,
            updated_at:t.exact_observed_at}));
          return{day:w.day,setId:`daily-window:${epoch.snapshot_at}`,selectedAt:epoch.snapshot_at,tickets:selected,
            groups:groupWindowConsumerTickets(selected)};
        });
        w.setId=plan.setId;w.total=plan.groups.length;w.totalRows=plan.tickets.length;w.sourceSelectedAt=plan.selectedAt;
        const group=plan.groups[w.cursor];
        if(group){
          if(group[0].departure_at<today){w.cursor++;w.expired=(w.expired??0)+group.length;}
          else{const age=Math.max(...group.map(ticket=>Math.max(0,clock()-Date.parse(ticket.updated_at))).filter(Number.isFinite));
            const ok=await exactGroup(group,deadline);w.cursor++;w.errors+=ok?0:1;
            w.oldestAgeMs=Math.max(w.oldestAgeMs??0,Number.isFinite(age)?age:0);w.lastRefreshedAt=clock();}
        }
        w.done=w.cursor>=w.total;cp.weekend=w;
        if(w.done){w.passCompletedAt=clock();w.fullCycleMs=w.passCompletedAt-w.passStartedAt;cp.phase='done';cp.completedAt=clock();cp.lagMs=Math.max(0,cp.completedAt-cp.dueAt);return{status:'done',checkpoint:cp};}
        return{status:'progress',checkpoint:cp};
      }
      return{status:'done',checkpoint:cp};
    }catch(error){if(error instanceof CollectionYield)return{status:'yield',checkpoint:cp};throw error;}
  }};

  // Retention/metrics are kept separate and always run after priority, MAIN and TAIL.
  const maintenance={maxUnitMs:45000,async step({job,deadline}){
    const cp=structuredClone(job.checkpoint??{turn:0,metricsDay:null,checked:{}});cp.checked??={};
    deadline=Math.min(deadline,clock()+35000);const now=clock();const today=berlinDay(now);
    try{for(let scan=0;scan<5;scan++){
      const turn=cp.turn%5;cp.turn++;
      if(turn<3){
        if(cp.checked[turn]===today)continue;
        const table=['app_errors','flight_price_feedback','destination_requests'][turn];
        const cutoff=turn===2?calendarMonthsAgoIso(new Date(now)):new Date(now-(turn===0?90:365)*DAY).toISOString();
        const rows=await query(()=>db.from(table).select('id').lt('created_at',cutoff).order('created_at').order('id').limit(100),deadline,{retry:true});
        if(rows.length){await query(()=>db.from(table).delete().in('id',rows.map(r=>r.id)),deadline,{retry:true});return{status:'progress',checkpoint:cp};}
        cp.checked[turn]=today;
      }else if(turn===3&&cp.metricsDay!==today){await query(()=>db.rpc('collect_storage_metrics'),deadline);cp.metricsDay=today;return{status:'progress',checkpoint:cp};
      }else if(turn===4&&cp.checked.plans!==today){
        const bucket=db.storage.from('price-snapshots');
        const rows=await query(()=>bucket.list('coordinator',{limit:100,sortBy:{column:'created_at',order:'asc'}}),deadline,{retry:true});
        const state=getState();const protectedNames=new Set(Object.entries(state?.jobs??{}).map(([task,j])=>`${task}-${j.id}-${j.checkpoint?.wave??wave}.json`));
        const p=state?.jobs?.priority?.checkpoint;if(p?.roulette)protectedNames.add(`roulette-${p.roulette.cycle}-0.json`);if(p?.weekend)protectedNames.add(`windowrefresh-${p.weekend.dayId}-0.json`);
        const expired=rows.filter(r=>/^(main|tail|fast|roulette|windowrefresh)-\d+-\d+\.json$/.test(r.name)&&!protectedNames.has(r.name)&&Date.parse(r.created_at)<now-35*DAY).map(r=>'coordinator/'+r.name);
        if(expired.length){await query(()=>bucket.remove(expired),deadline,{retry:true});return{status:'progress',checkpoint:cp};}
        cp.checked.plans=today;
      }
    }return{status:'empty',checkpoint:cp};
    }catch(error){if(error instanceof CollectionYield)return{status:'yield',checkpoint:cp};throw error;}
  }};
  return{priority,main,fast:windowAdapter('fast'),tail:windowAdapter('tail'),maintenance};
}
