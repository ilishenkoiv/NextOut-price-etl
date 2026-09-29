// Once-per-Berlin-day publication of the complete shared exact-price carousel candidate union.
// Reads factual calendars/window_prices, point-refreshes selected tickets when supplied a provider,
// then atomically publishes v1.
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { computeAllWindows } from './collection-windows.mjs';
import { berlinObservedOn, nightlySelectionDue, publishedSnapshotDestinations, publishedSnapshotOrigins, freshOriginFraction, LEGACY_SELECTION_THRESHOLD_MINUTES, PILOT_SELECTION_THRESHOLD_MINUTES } from './snapshot-daily-origin-cheapest.mjs';
import { destinationIdForIata } from '../src/data/destination-identities.js';
import { marketForOrigin } from '../src/data/origin-markets.js';
import { recordRead } from './collection-egress.mjs';
import { pointRefreshTickets, ticketKey } from './daily-selection-refresh.mjs';
import { horizon } from './collection-planning.mjs';
import { attachCarouselSixMonthMinimum, chooseCarouselCityForWindow, preserveCarouselSixMonthMinimum } from './carousel-six-month-contract.mjs';
import { CollectionProvider } from './collection-provider.mjs';
import { DAILY_SELECTION_REFRESH_MAX_MS } from './daily-selection-budget.mjs';

const PAGE=1000,CONTRACT_VERSION=1;
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const addMonths=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+n);return d.toISOString().slice(0,10);};
const windowKey=(start,end)=>`${start}|${end}`;
const routeKey=row=>[row.origin,row.dest,row.departure_at,row.return_at].join('|');

export function buildWindowRegionMap(holidays,regions,today){const result=new Map();
  for(const region of regions){for(const w of computeAllWindows(holidays,[region],today,{horizonMonths:4})){
    if(w.kind!=='holiday')continue;const key=windowKey(w.start,w.end);if(!result.has(key))result.set(key,new Set());result.get(key).add(region);}}
  return result;
}

export function selectDailyWindowCandidates(rows,{today,snapshotAt,holidays=[],regions=[],originRegions=[],wave=0}={}){
  const min=addDays(today,10),max=addMonths(today,4),allowedDests=publishedSnapshotDestinations(wave),allowedOrigins=publishedSnapshotOrigins();
  const factual=computeAllWindows(holidays,regions,today,{horizonMonths:4});const factualByKey=new Map(factual.map(w=>[windowKey(w.start,w.end),w]));
  const weekends=new Set(computeAllWindows([],[],today,{horizonMonths:4}).map(w=>windowKey(w.start,w.end)));
  const regionMap=buildWindowRegionMap(holidays,regions,today);
  const regionForOrigin=new Map(originRegions.map(row=>[row.airport,row.calendar_subdivision_code]));
  const exact=new Map();
  for(const row of rows){const key=windowKey(row.departure_at,row.return_at),w=factualByKey.get(key),updated=Date.parse(row.updated_at);
    if(!w||!allowedOrigins.has(row.origin)||!allowedDests.has(row.dest)||!destinationIdForIata(row.dest)||row.departure_at<min||row.departure_at>max
      ||row.return_at<=row.departure_at||!['direct','any'].includes(row.flight_type)||!(Number(row.price)>0)||!Number.isFinite(updated))continue;
    const holidayRegions=[...(regionMap.get(key)??[])].sort(),originRegion=regionForOrigin.get(row.origin);
    const window=originRegion&&holidayRegions.includes(originRegion)?{...w,kind:'holiday',regionCodes:[originRegion]}:
      weekends.has(key)?{...w,kind:'weekend',regionCodes:[]}:null;
    if(!window)continue;
    const route=routeKey(row),entry=exact.get(route)??{direct:null,any:null,window};const old=entry[row.flight_type];
    if(!old||Number(row.price)<Number(old.price)||Number(row.price)===Number(old.price)&&String(row.updated_at).localeCompare(String(old.updated_at))>0)entry[row.flight_type]=row;
    exact.set(route,entry);
  }
  const candidates=[];
  for(const entry of exact.values()){const rowsByMode=[entry.direct&&{mode:'direct',row:entry.direct},(entry.direct||entry.any)&&{mode:'any',row:
      [entry.direct,entry.any].filter(Boolean).sort((a,b)=>Number(a.price)-Number(b.price)||String(b.updated_at).localeCompare(String(a.updated_at)))[0]}].filter(Boolean);
    for(const {mode,row} of rowsByMode)candidates.push({contract_version:CONTRACT_VERSION,observed_on:today,snapshot_at:snapshotAt,
      origin:row.origin,market:marketForOrigin(row.origin),flight_type:mode,region_codes:entry.window.regionCodes,
      window_kind:entry.window.kind,departure_at:row.departure_at,return_at:row.return_at,dest:row.dest,destination_id:destinationIdForIata(row.dest),
      exact_price:Number(row.price),currency:'EUR',transfers:Number.isInteger(row.transfers)?row.transfers:null,airline:row.airline??null,
      exact_observed_at:row.updated_at,refresh_status:'fresh',refresh_checked_at:row.updated_at,last_error_kind:null,price_source:row.price_source??null});}
  const groups=new Map();for(const row of candidates){const key=[row.origin,row.flight_type,row.departure_at,row.return_at].join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  const orderedGroups=[...groups.values()].sort((a,b)=>a[0].origin.localeCompare(b[0].origin)||a[0].flight_type.localeCompare(b[0].flight_type)
    ||a[0].departure_at.localeCompare(b[0].departure_at)||a[0].return_at.localeCompare(b[0].return_at));
  const usedBySeries=new Map(),output=[];
  for(const group of orderedGroups){group.sort((a,b)=>a.exact_price-b.exact_price||String(b.exact_observed_at).localeCompare(String(a.exact_observed_at))
    ||Number(a.transfers??99)-Number(b.transfers??99)||a.destination_id.localeCompare(b.destination_id));
    const seriesKey=[group[0].origin,group[0].flight_type].join('|'),usedCities=usedBySeries.get(seriesKey)??new Set();
    const selection=chooseCarouselCityForWindow(group,usedCities);if(!selection)continue;
    usedCities.add(selection.candidate.dest);usedBySeries.set(seriesKey,usedCities);
    const ordered=[selection.candidate,...group.filter(row=>row!==selection.candidate)];
    ordered.forEach((row,index)=>output.push({...row,position:index+1}));}
  return output.sort((a,b)=>a.origin.localeCompare(b.origin)||a.flight_type.localeCompare(b.flight_type)||a.departure_at.localeCompare(b.departure_at)
    ||a.return_at.localeCompare(b.return_at)||a.position-b.position);
}

async function loadAll(db,table,columns,order,filter){const out=[];for(let from=0;;from+=PAGE){let q=db.from(table).select(columns);if(filter)q=filter(q);for(const col of order)q=q.order(col,{ascending:true});
  const{data,error}=await q.range(from,from+PAGE-1);if(error)throw error;out.push(...(data??[]));recordRead(table,data);if((data??[]).length<PAGE)return out;}}

export async function main({db,instant=Date.now(),wave=Number(process.env.SNAPSHOT_EXPANSION_WAVE??0),force=process.env.SNAPSHOT_FORCE_REBUILD==='true',
  pilotMarketSchedule=false,provider=null,refreshDeadline=Infinity,requireCompleteRefresh=false,clock=Date.now}={}){
  const today=berlinObservedOn(instant);
  // Pilot's own threshold is the only one consulted when pilotMarketSchedule is set — see the
  // matching comment in snapshot-daily-origin-cheapest.mjs's main().
  const selectionThresholdMinutes=pilotMarketSchedule?PILOT_SELECTION_THRESHOLD_MINUTES:LEGACY_SELECTION_THRESHOLD_MINUTES;
  if(!force&&!nightlySelectionDue(instant,selectionThresholdMinutes))return{published:false,reason:'not_due',observedOn:today};
  if(!db&&!process.env.SUPABASE_SERVICE_KEY)throw new Error('Missing SUPABASE_SERVICE_KEY');
  const client=db??createClient(process.env.SUPABASE_URL||'https://xpalogebawoljlafsafs.supabase.co',process.env.SUPABASE_SERVICE_KEY,{auth:{persistSession:false}});
  // Date bounds stay server-side. Observation age is diagnostic only: a last-known positive exact
  // window remains eligible and is point-refreshed after selection.
  const windowMin=addDays(today,10),windowMax=addMonths(today,4);
  const [rows,holidays,originRegions]=await Promise.all([
    loadAll(client,'window_prices','origin,dest,flight_type,departure_at,return_at,price,transfers,airline,updated_at,price_source',['origin','dest','flight_type','departure_at','return_at'],
      q=>q.gte('departure_at',windowMin).lte('departure_at',windowMax)),
    loadAll(client,'public_holidays','country,subdivision_code,level,date',['country','subdivision_code','date']),
    loadAll(client,'origin_regions','airport,calendar_subdivision_code',['airport'])]);
  // Selection never waits for freshness — this is observability only (see the
  // daily_selection_published event below), same as the roulette pool.
  const freshFraction=freshOriginFraction(rows,instant,publishedSnapshotOrigins());
  const regions=[...new Set(originRegions.map(r=>r.calendar_subdivision_code).filter(Boolean))].sort();const snapshotAt=new Date(instant).toISOString();
  let candidates=selectDailyWindowCandidates(rows,{today,snapshotAt,holidays,regions,originRegions,wave});if(!candidates.length)throw new Error('Daily window candidate selection is empty');
  const months=horizon(today),origins=[...new Set(candidates.map(row=>row.origin))],dests=[...new Set(candidates.map(row=>row.dest))];
  const monthlyRows=await loadAll(client,'prices','origin,dest,month,direct,any_stops,updated_at,price_source',['origin','dest','month'],
    q=>q.in('month',months).in('origin',origins).in('dest',dests));
  candidates=attachCarouselSixMonthMinimum(candidates,monthlyRows,months);
  // Point-refresh: confirm the SELECTED carousel candidates' exact prices before publishing
  // (order: select -> point-refresh -> publish). Sequential, normal pace, never re-reads
  // window_prices. An unconfirmed 'no_result' marks the row unavailable without touching
  // exact_price (existing collection_commit_window_candidate write rule); a row the deadline is
  // reached before reaching keeps its selection-time value untouched, to be confirmed later by
  // the ordinary scheduled cadence.
  let refresh={attempted:0,refreshed:0,misses:0,errors:0,total:0};
  if(provider){
    const {confirmed,missed,errored,...stats}=await pointRefreshTickets(candidates,{provider,clock,deadline:refreshDeadline,sourceTable:'window_prices'});
    refresh=stats;
    for(let i=0;i<candidates.length;i++){
      const key=ticketKey(candidates[i]),c=confirmed.get(key);
      if(c)candidates[i]={...candidates[i],exact_price:c.price,transfers:c.transfers,airline:c.airline,
        exact_observed_at:c.updated_at,refresh_status:'fresh',refresh_checked_at:c.updated_at,last_error_kind:null,
        price_source:preserveCarouselSixMonthMinimum(c.price_source,candidates[i].price_source)};
      else if(missed.has(key))candidates[i]={...candidates[i],refresh_status:'unavailable',refresh_checked_at:new Date(clock()).toISOString()};
      else if(errored.has(key))candidates[i]={...candidates[i],refresh_status:'failed',refresh_checked_at:new Date(clock()).toISOString(),
        last_error_kind:'point_refresh_error'};
    }
  }
  if(requireCompleteRefresh&&(!provider||refresh.attempted!==refresh.total)){
    throw new Error(`Manual daily window recovery refused incomplete point refresh (${refresh.attempted}/${refresh.total})`);
  }
  const{data,error}=await client.rpc('publish_daily_window_candidates',{p_observed_on:today,p_snapshot_at:snapshotAt,p_candidates:candidates});if(error)throw error;
  const requestGroups=new Set(candidates.map(routeKey)).size;console.log(JSON.stringify({event:'daily_selection_published',scope:'window',published:data===true,observedOn:today,snapshotAt,
    candidateRows:candidates.length,requestGroups,origins:new Set(candidates.map(r=>r.origin)).size,freshFraction,refresh}));
  return{published:data===true,observedOn:today,snapshotAt,candidateRows:candidates.length,requestGroups,freshFraction,refresh};
}

export async function manualRecoveryMain({env=process.env,publish=main,providerFactory=options=>new CollectionProvider(options),clock=Date.now}={}){
  const token=typeof env.TP_TOKEN==='string'?env.TP_TOKEN.trim():'';
  if(!token)throw new Error('Manual daily window recovery requires TP_TOKEN; refusing unrefreshed publication');
  const provider=providerFactory({token,lease:async()=>true,clock});
  return publish({provider,clock,refreshDeadline:clock()+DAILY_SELECTION_REFRESH_MAX_MS,requireCompleteRefresh:true});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  manualRecoveryMain().catch(error=>{console.error(error.message);process.exitCode=1;});
}
