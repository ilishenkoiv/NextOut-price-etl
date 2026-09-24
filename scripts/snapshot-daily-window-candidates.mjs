// Once-per-Berlin-day publication of the complete shared exact-price carousel candidate union.
// No provider requests: reads existing factual calendars/window_prices and atomically publishes v1.
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { computeAllWindows } from './collection-windows.mjs';
import { berlinObservedOn, nightlySelectionDue, publishedSnapshotDestinations, publishedSnapshotOrigins, pilotSourcesReady } from './snapshot-daily-origin-cheapest.mjs';
import { destinationIdForIata } from '../src/data/destination-identities.js';
import { marketForOrigin } from '../src/data/origin-markets.js';

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

export function selectDailyWindowCandidates(rows,{today,snapshotAt,holidays=[],regions=[],wave=0}={}){
  const min=addDays(today,10),max=addMonths(today,4),allowedDests=publishedSnapshotDestinations(wave),allowedOrigins=publishedSnapshotOrigins();
  const factual=computeAllWindows(holidays,regions,today,{horizonMonths:4});const factualByKey=new Map(factual.map(w=>[windowKey(w.start,w.end),w]));
  const regionMap=buildWindowRegionMap(holidays,regions,today),freshCutoff=Date.parse(snapshotAt)-36*60*60*1000;
  const exact=new Map();
  for(const row of rows){const w=factualByKey.get(windowKey(row.departure_at,row.return_at)),updated=Date.parse(row.updated_at);
    if(!w||!allowedOrigins.has(row.origin)||!allowedDests.has(row.dest)||!destinationIdForIata(row.dest)||row.departure_at<min||row.departure_at>max
      ||row.return_at<=row.departure_at||!['direct','any'].includes(row.flight_type)||!(Number(row.price)>0)||!Number.isFinite(updated)||updated<freshCutoff)continue;
    const key=routeKey(row),entry=exact.get(key)??{direct:null,any:null,window:w};const old=entry[row.flight_type];
    if(!old||Number(row.price)<Number(old.price)||Number(row.price)===Number(old.price)&&String(row.updated_at).localeCompare(String(old.updated_at))>0)entry[row.flight_type]=row;
    exact.set(key,entry);
  }
  const candidates=[];
  for(const entry of exact.values()){const rowsByMode=[entry.direct&&{mode:'direct',row:entry.direct},(entry.direct||entry.any)&&{mode:'any',row:
      [entry.direct,entry.any].filter(Boolean).sort((a,b)=>Number(a.price)-Number(b.price)||String(b.updated_at).localeCompare(String(a.updated_at)))[0]}].filter(Boolean);
    for(const {mode,row} of rowsByMode)candidates.push({contract_version:CONTRACT_VERSION,observed_on:today,snapshot_at:snapshotAt,
      origin:row.origin,market:marketForOrigin(row.origin),flight_type:mode,region_codes:entry.window.kind==='holiday'?[...(regionMap.get(windowKey(row.departure_at,row.return_at))??[])].sort():[],
      window_kind:entry.window.kind,departure_at:row.departure_at,return_at:row.return_at,dest:row.dest,destination_id:destinationIdForIata(row.dest),
      exact_price:Number(row.price),currency:'EUR',transfers:Number.isInteger(row.transfers)?row.transfers:null,airline:row.airline??null,
      exact_observed_at:row.updated_at,refresh_status:'fresh',refresh_checked_at:row.updated_at,last_error_kind:null,price_source:row.price_source??null});}
  const groups=new Map();for(const row of candidates){const key=[row.origin,row.flight_type,row.departure_at,row.return_at].join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  const output=[];for(const group of groups.values()){group.sort((a,b)=>a.exact_price-b.exact_price||String(b.exact_observed_at).localeCompare(String(a.exact_observed_at))
    ||Number(a.transfers??99)-Number(b.transfers??99)||a.destination_id.localeCompare(b.destination_id));group.forEach((row,index)=>output.push({...row,position:index+1}));}
  return output.sort((a,b)=>a.origin.localeCompare(b.origin)||a.flight_type.localeCompare(b.flight_type)||a.departure_at.localeCompare(b.departure_at)
    ||a.return_at.localeCompare(b.return_at)||a.position-b.position);
}

async function loadAll(db,table,columns,order){const out=[];for(let from=0;;from+=PAGE){let q=db.from(table).select(columns);for(const col of order)q=q.order(col,{ascending:true});
  const{data,error}=await q.range(from,from+PAGE-1);if(error)throw error;out.push(...(data??[]));if((data??[]).length<PAGE)return out;}}

export async function main({db,instant=Date.now(),wave=Number(process.env.SNAPSHOT_EXPANSION_WAVE??0),force=process.env.SNAPSHOT_FORCE_REBUILD==='true',pilotMarketSchedule=false}={}){
  const today=berlinObservedOn(instant);if(!force&&!nightlySelectionDue(instant))return{published:false,reason:'not_due',observedOn:today};
  if(!db&&!process.env.SUPABASE_SERVICE_KEY)throw new Error('Missing SUPABASE_SERVICE_KEY');
  const client=db??createClient(process.env.SUPABASE_URL||'https://xpalogebawoljlafsafs.supabase.co',process.env.SUPABASE_SERVICE_KEY,{auth:{persistSession:false}});
  const [rows,holidays,originRegions]=await Promise.all([
    loadAll(client,'window_prices','origin,dest,flight_type,departure_at,return_at,price,transfers,airline,updated_at,price_source',['origin','dest','flight_type','departure_at','return_at']),
    loadAll(client,'public_holidays','country,subdivision_code,level,date',['country','subdivision_code','date']),
    loadAll(client,'origin_regions','airport,calendar_subdivision_code',['airport'])]);
  // PILOT ONLY: same principle as the roulette pool (snapshot-daily-origin-cheapest.mjs) — time
  // alone (nightlySelectionDue) does not prove the post-pause 07:00 pass has landed. A delay or
  // error there must not publish today's carousel candidates from stale pre-pause window_prices.
  if(pilotMarketSchedule&&!force&&!pilotSourcesReady(rows,instant,publishedSnapshotOrigins()))
    return{published:false,reason:'sources_not_fresh',observedOn:today};
  const regions=[...new Set(originRegions.map(r=>r.calendar_subdivision_code).filter(Boolean))].sort();const snapshotAt=new Date(instant).toISOString();
  const candidates=selectDailyWindowCandidates(rows,{today,snapshotAt,holidays,regions,wave});if(!candidates.length)throw new Error('Daily window candidate selection is empty');
  const{data,error}=await client.rpc('publish_daily_window_candidates',{p_observed_on:today,p_snapshot_at:snapshotAt,p_candidates:candidates});if(error)throw error;
  const requestGroups=new Set(candidates.map(routeKey)).size;console.log(JSON.stringify({event:'daily_window_candidates',published:data===true,observedOn:today,snapshotAt,
    candidateRows:candidates.length,requestGroups,origins:new Set(candidates.map(r=>r.origin)).size}));
  return{published:data===true,observedOn:today,snapshotAt,candidateRows:candidates.length,requestGroups};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
