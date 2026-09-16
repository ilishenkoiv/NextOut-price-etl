import { probeType, fetchCalendarMonth, selectCombo } from './fetch-prices.mjs';
import { monthlyQuoteProvenance } from './quote-integrity.mjs';
import { withPriceProvenance } from './price-provenance.mjs';
import { marketForOrigin } from '../src/data/origin-markets.js';
import { mainPlan, tailPlan, fastPlan, nextMonth, horizon } from './collection-planning.mjs';
import { computeAllWindows } from './collection-windows.mjs';
import { buildBreakWindows } from './break-windows.mjs';
import { CollectionYield } from './collection-provider.mjs';
import { classifyResponse, ticketFromFeedback } from './check-flight-price-feedback.mjs';
import { calendarMonthsAgoIso } from './destination-request-retention.mjs';
import { main as publishSnapshot } from './snapshot-daily-origin-cheapest.mjs';
import { gzipSync } from 'node:zlib';

const PRICE_ORDER = ['origin','dest','month'];
const WINDOW_ORDER = ['origin','dest','flight_type','departure_at','return_at'];
const DAY = 86400000;

export function createAdapters({ db, store, provider, wave = 0, clock = Date.now, setDbDeadline = () => {}, getState = () => null }) {
  const exactKey=t=>[t.origin,t.dest,t.flight_type,t.departure_at,t.return_at].join('|');
  async function query(builder, deadline = Infinity) {
    if (clock() + 9000 >= deadline) throw new CollectionYield('Database unit would cross boundary');
    if (!await store.lease()) throw new Error('Database operation forbidden: lease lost');
    const result = await builder;
    if (result.error) throw new Error(`Collection database operation failed (${result.error.code ?? 'unknown'})`);
    return result.data;
  }
  async function load(table, columns, order, apply = q => q, deadline = Infinity) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      let q = db.from(table).select(columns); for (const key of order) q = q.order(key);
      const data = await query(apply(q).range(from, from + 999), deadline);
      rows.push(...data); if (data.length < 1000) return rows;
    }
  }
  const watches = deadline => load('price_watch_push_rules','origin,dest,watch_scope,country_code',
    ['installation_id','watch_id'],q => q.eq('active',true),deadline);
  async function durablePlan(task, job, build) {
    return store.plan(`coordinator/${task}-${job.id}-${job.checkpoint?.wave??wave}.json`, build);
  }
  async function commit(name, payload, deadline) {
    const accepted=await query(db.rpc(name, { ...store.args(), ...payload }), deadline);
    if(accepted!==true)throw new Error('Collection write was not acknowledged');
    return accepted;
  }

  const main = {
    maxUnitMs: job => job.checkpoint?.stage==='snapshot' ? 480_000 : 45_000,
    async step({ job, deadline }) {
      const unitEnd = Math.min(deadline, clock() + 30_000);
      let cp = job.checkpoint ?? { cursor: 0, errors: 0, wave };
      const pinnedWave=cp.wave??wave;
      cp={...cp,wave:pinnedWave};
      try {
        if (cp.stage === 'snapshot') {
          setDbDeadline(Math.min(deadline,clock()+470000));
          try {
            await publishSnapshot({db,snapshotAt:cp.snapshotAt,expansionWave:cp.snapshotWave??0});
            const rows=await query(db.from('daily_origin_cheapest_pool').select('snapshot_at').eq('snapshot_at',cp.snapshotAt).limit(1),deadline);
            if(!rows.length)throw new Error('Main pass snapshot was not published');
          } finally { setDbDeadline(Infinity); }
          return {status:'done',checkpoint:{...cp,stage:'complete'}};
        }
        const plan = await durablePlan('main',{...job,checkpoint:cp},async () => {
          const months = horizon(job.planDate);
          const prices = await load('prices','origin,dest,month,direct,any_stops',PRICE_ORDER,q=>q.in('month',months),unitEnd);
          const watchRows = await watches(unitEnd);
          const holidays = await load('public_holidays','country,subdivision_code,level,date',['country','subdivision_code','date'],q=>q.gte('date',months[0]+'-01').lt('date',nextMonth(months.at(-1))+'-01'),unitEnd);
          const regions = await load('origin_regions','airport,calendar_subdivision_code',['airport'],undefined,unitEnd);
          const codes = new Set(regions.map(r=>r.calendar_subdivision_code));
          const days = new Set(holidays.filter(h=>codes.has(h.subdivision_code) || (h.level==='country' && [...codes].some(c=>c.startsWith(h.country+'-')))).map(h=>h.date));
          return { ...mainPlan({date:job.planDate,wave:pinnedWave,prices,watches:watchRows}),
            breakKeys:[...buildBreakWindows(days,months[0]+'-01',nextMonth(months.at(-1))+'-01').keySet] };
        });
        const total = plan.routes.length * plan.months.length;
        // A cursor is advanced only after the complete cell has been committed.
        while (cp.cursor < total && clock() + 15000 < unitEnd) {
          const route = plan.routes[cp.cursor % plan.routes.length];
          const month = plan.months[Math.floor(cp.cursor / plan.routes.length)];
          const natural = route.stops !== 1; let usedType = natural ? 'direct' : 'any';
          const request = url => provider.request(url, unitEnd - 9000);
          let result = await probeType(route.origin,route.dest,month,nextMonth(month),natural,request);
          if (result.ok && result.min == null) {
            const alt = await probeType(route.origin,route.dest,month,nextMonth(month),!natural,request);
            if (alt.ok && alt.min != null) { result=alt; usedType=natural?'any':'direct'; }
            else {
              const cal = await fetchCalendarMonth(route.origin,route.dest,month,request);
              if (cal.ok && cal.min != null) { result=cal; usedType=cal.type; }
              else if(!alt.ok)result={ok:false,min:null,offers:[]};
            }
          }
          if (result.ok) {
            const price = withPriceProvenance([{ origin:route.origin,dest:route.dest,market:marketForOrigin(route.origin),month,
              direct:usedType==='direct'?result.min:null,any_stops:usedType==='any'?result.min:null,
              updated_at:new Date(clock()).toISOString(),price_source:monthlyQuoteProvenance(result.offers,result.min) }],'prices')[0];
            const offers = withPriceProvenance(selectCombo(result.offers,route.origin,route.dest,new Set(plan.breakKeys)),'offers');
            await commit('collection_commit_main',{ p_price:price,p_offers:offers },unitEnd);
          }
          cp = { ...cp, cursor:cp.cursor+1, errors:cp.errors+(result.ok?0:1), total };
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
          await query(db.storage.from('price-snapshots').upload(path,gzipSync(csv),{contentType:'application/gzip',upsert:true}),unitEnd);
          return {status:'progress',checkpoint:{...cp,stage:'snapshot',snapshotAt:new Date(clock()).toISOString(),snapshotPath:path,
            snapshotWave:Number(process.env.SNAPSHOT_EXPANSION_WAVE||0)}};
        }
        return { status:'progress',checkpoint:cp };
      } catch (error) {
        if (error instanceof CollectionYield) return { status:'yield',checkpoint:cp };
        throw error;
      }
    },
  };

  async function exact(ticket, deadline) {
    const params = new URLSearchParams({ origin:ticket.origin,destination:ticket.dest,
      departure_at:ticket.departure_at,return_at:ticket.return_at,direct:String(ticket.flight_type==='direct'),
      market:marketForOrigin(ticket.origin),currency:'eur',one_way:'false',limit:'500' });
    const response = await provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?'+params,deadline-9000);
    const outcome = response.kind==='ok' ? classifyResponse(response.json,{
      origin:ticket.origin,dest:ticket.dest,depart:ticket.departure_at,ret:ticket.return_at,mode:ticket.flight_type,
    }) : {status:'error',detail:response.kind==='refused'?'provider_refused':'provider_error'};
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
    await commit('collection_commit_window',{p_fare:fare,p_miss:miss},deadline);
    return outcome.status!=='error';
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

  // Small bounded batches alternate with audit work, so neither a busy feedback
  // queue nor large retention backlog can monopolize the five-minute windows.
  const maintenance={maxUnitMs:45000,async step({job,deadline}){
    const cp=structuredClone(job.checkpoint??{turn:0,metricsDay:null,checked:{}});
    cp.checked??={};deadline=Math.min(deadline,clock()+35000);
    try { for(let scan=0;scan<7;scan++) {
    const turn=cp.turn%7;cp.turn++;
    const now=clock();const today=new Date(now).toISOString().slice(0,10);let didWork=false;
    if(turn===0){
      if(cp.auditRetryAt>now)continue;
      const rows=await query(db.rpc('claim_flight_price_audit'),deadline);
      const row=rows?.[0];
      if(row){
        const ticket=ticketFromFeedback(row.feedback,new Date(now).toISOString().slice(0,10));
        let outcome={status:'not_requested',detail:'missing_exact_context'};
        if(ticket){
          const params=new URLSearchParams({origin:ticket.origin,destination:ticket.dest,departure_at:ticket.depart,return_at:ticket.ret,
            direct:String(ticket.mode==='direct'),market:marketForOrigin(ticket.origin),currency:'eur',one_way:'false',limit:'500'});
          try{const response=await provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?'+params,deadline-9000);
            outcome=response.kind==='ok'?classifyResponse(response.json,ticket):{status:'error',detail:'provider_error'};
          }catch(error){if(error instanceof CollectionYield)outcome={status:'pending',detail:'scheduler_pause'};else throw error;}
        }
        const result=await query(db.rpc('finish_flight_price_audit',{p_feedback_id:row.feedback_id,p_claim_token:row.claim_token,
          p_status:outcome.status,p_price:outcome.price??null,p_detail:outcome.detail,p_run_id:store.runId}),deadline);
        if(result!==true)throw new Error('Audit claim expired before completion');didWork=true;
      }else cp.auditRetryAt=now+30000;
    }else if(turn===1){
      const desiredCycle=Math.floor(now/1800000);
      let r=cp.roulette;
      if(!r||(r.done&&r.cycle!==desiredCycle))r={cycle:desiredCycle,cursor:0,done:false,errors:0};
      if(r.done)continue;
      const plan=await store.plan(`coordinator/roulette-${r.cycle}-0.json`,async()=>{
        const latest=await query(db.from('daily_origin_cheapest_pool').select('snapshot_at').order('snapshot_at',{ascending:false}).limit(1),deadline);
        if(!latest.length)return{tickets:[]};
        const tickets=await load('daily_origin_cheapest_pool','origin,dest,flight_type,departure_at,return_at,rank',
          ['origin','flight_type','rank'],q=>q.eq('snapshot_at',latest[0].snapshot_at),deadline);
        return{tickets:tickets.filter(t=>t.departure_at>=today&&t.return_at>t.departure_at)};
      });
      const ticket=plan.tickets[r.cursor];
      if(ticket){
        const params=new URLSearchParams({origin:ticket.origin,destination:ticket.dest,departure_at:ticket.departure_at,return_at:ticket.return_at,
          direct:String(ticket.flight_type==='direct'),market:marketForOrigin(ticket.origin),currency:'eur',one_way:'false',limit:'500'});
        const response=await provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?'+params,deadline-9000);
        const result=response.kind==='ok'?classifyResponse(response.json,{origin:ticket.origin,dest:ticket.dest,depart:ticket.departure_at,ret:ticket.return_at,mode:ticket.flight_type}):{status:'error'};
        const source=Array.isArray(response.json?.data)?response.json.data.find(row=>classifyResponse({success:true,data:[row]},
          {origin:ticket.origin,dest:ticket.dest,depart:ticket.departure_at,ret:ticket.return_at,mode:ticket.flight_type}).price===result.price):undefined;
        const patch=withPriceProvenance([{...result,updated_at:new Date(clock()).toISOString(),market:marketForOrigin(ticket.origin),flight_type:ticket.flight_type,
          transfers:Number.isInteger(source?.transfers)?source.transfers:null,airline:typeof source?.airline==='string'?source.airline:null}],'offers')[0];
        await commit('collection_commit_roulette',{p_ticket:{...ticket,month:ticket.departure_at.slice(0,7)},p_result:patch},deadline);
        r.cursor++;r.errors+=result.status==='error'?1:0;didWork=true;
      }
      r.done=r.cursor>=plan.tickets.length;cp.roulette=r;
    }else if(turn<5){
      if(cp.checked[turn]===today)continue;
      const table=['','','app_errors','flight_price_feedback','destination_requests'][turn];
      const cutoff=turn===4?calendarMonthsAgoIso(new Date(now)):new Date(now-(turn===2?90:365)*DAY).toISOString();
      const rows=await query(db.from(table).select('id').lt('created_at',cutoff).order('created_at').order('id').limit(100),deadline);
      if(rows.length){await query(db.from(table).delete().in('id',rows.map(r=>r.id)),deadline);didWork=true;}
      if(rows.length<100)cp.checked[turn]=today;
    }else if(turn===5&&cp.metricsDay!==today){
      await query(db.rpc('collect_storage_metrics'),deadline);cp.metricsDay=today;didWork=true;
    }else if(turn===6&&cp.checked.plans!==today){
      const bucket=db.storage.from('price-snapshots');
      const rows=await query(bucket.list('coordinator',{limit:100,sortBy:{column:'created_at',order:'asc'}}),deadline);
      const state=getState();const protectedNames=new Set(Object.entries(state?.jobs??{}).map(([task,j])=>`${task}-${j.id}-${j.checkpoint?.wave??wave}.json`));
      if(cp.roulette)protectedNames.add(`roulette-${cp.roulette.cycle}-0.json`);
      const expired=rows.filter(r=>/^(main|tail|fast|roulette)-\d+-\d+\.json$/.test(r.name)&&
        !protectedNames.has(r.name)&&Date.parse(r.created_at)<now-35*DAY).map(r=>'coordinator/'+r.name);
      if(expired.length){await query(bucket.remove(expired),deadline);didWork=true;}
      if(expired.length<100)cp.checked.plans=today;
    }
    if(didWork)return{status:'progress',checkpoint:cp};
    }
    return{status:'empty',checkpoint:cp};
    }catch(error){if(error instanceof CollectionYield)return{status:'yield',checkpoint:cp};throw error;}
  }};
  return{main,fast:windowAdapter('fast'),tail:windowAdapter('tail'),maintenance};
}
