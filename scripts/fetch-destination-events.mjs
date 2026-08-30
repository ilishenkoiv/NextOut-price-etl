// Monthly exact-date event discovery for the rolling next six months.
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { DESTINATIONS } from '../src/data/destinations.js';
import { CITIES } from '../src/data/cities.js';
import { DEST_COORDS } from '../src/data/coords.js';
import { CURATED_DESTINATION_HOLIDAYS } from '../src/data/destination-holidays.js';
import { buildEventQuery, mapConcurrent, rowsFromBindings, rowsFromCuratedHolidays, sixMonthWindow, WIKIDATA_SOURCE } from './destination-events.mjs';

const URL=process.env.SUPABASE_URL||'https://xpalogebawoljlafsafs.supabase.co', KEY=process.env.SUPABASE_SERVICE_KEY;
const DRY=(process.env.DRY_RUN||'').trim()==='1';
const RADIUS=Math.max(5,Math.min(75,Number(process.env.WIKIDATA_RADIUS_KM)||35));
const ONLY=new Set((process.env.EVENT_IATAS||'').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean));
const ENDPOINT='https://query.wikidata.org/sparql';
const AGENT=process.env.WIKIDATA_USER_AGENT||'NextOutDestinationEvents/1.0 (https://nextout.de; kontakt@nextout.de)';
const GAP=Math.max(100,Number(process.env.WIKIDATA_REQUEST_GAP_MS)||350), CHUNK=250;
const CONCURRENCY=Math.max(1,Math.min(5,Math.trunc(Number(process.env.WIKIDATA_CONCURRENCY)||3)));
if(!DRY&&!KEY){console.error('Missing SUPABASE_SERVICE_KEY (or use DRY_RUN=1).');process.exit(1);}
const db=KEY?createClient(URL,KEY,{auth:{persistSession:false,autoRefreshToken:false},realtime:{transport:WebSocket}}):null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const runAt=new Date().toISOString(); const window=sixMonthWindow();let nextRequestAt=0;

async function waitForRequestSlot(){const now=Date.now(),delay=Math.max(0,nextRequestAt-now);nextRequestAt=Math.max(now,nextRequestAt)+GAP;if(delay)await sleep(delay);}

function targets(){return DESTINATIONS.filter(d=>!ONLY.size||ONLY.has(d.iata)).map(d=>{
  const city=CITIES[d.iata],coord=DEST_COORDS[d.iata];if(!city||!coord)throw new Error(`Missing city/coords: ${d.iata}`);
  return {iata:d.iata,city:city.city,country:city.country,lat:coord[0],lon:coord[1]};
});}

async function fetchBindings(dest){
  await waitForRequestSlot();
  const query=buildEventQuery({...dest,from:window.from,to:window.to,radiusKm:RADIUS});
  const target=`${ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;let last;
  for(let attempt=1;attempt<=3;attempt++){
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),45_000);
    try{const res=await fetch(target,{headers:{accept:'application/sparql-results+json','user-agent':AGENT},signal:ctl.signal});
      if(!res.ok)throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,240)}`);
      return (await res.json()).results?.bindings??[];
    }catch(e){last=e;if(attempt<3)await sleep(1000*2**(attempt-1));}finally{clearTimeout(timer);}
  }throw new Error(`Wikidata ${dest.iata}: ${last?.message||last}`);
}

async function tableReady(){if(DRY)return true;const p=await db.from('destination_events').select('source').limit(1);
  if(!p.error)return true;if(/destination_events|schema cache|does not exist|PGRST205|42P01/i.test(p.error.message||'')){console.log('Migration not applied — safe no-op.');return false;}throw p.error;}

async function main(){
  console.log(`Destination events ${window.from}..${window.to}; ${RADIUS}km; Wikidata CC0; dry=${DRY}; concurrency=${CONCURRENCY}`);
  const list=targets();
  const batches=await mapConcurrent(list,CONCURRENCY,async(d,i)=>{const bindings=await fetchBindings(d),rows=rowsFromBindings(bindings,d,runAt);
    console.log(`${String(i+1).padStart(3)}/${list.length} ${d.iata} ${d.city}: ${bindings.length} bindings -> ${rows.length}`);return rows;});
  const curated=rowsFromCuratedHolidays(CURATED_DESTINATION_HOLIDAYS.filter((entry)=>!ONLY.size||ONLY.has(entry.destinationIata)),runAt,window);
  console.log(`Curated official editions: ${curated.length}`);
  const all=[...curated,...batches.flat()];
  const unique=new Map();for(const r of all)unique.set(`${r.source}|${r.source_id}|${r.destination_iata}|${r.event_start}`,r);const rows=[...unique.values()];
  console.log(`Total ${rows.length} candidates, ${new Set(rows.map(r=>r.destination_iata)).size}/${list.length} destinations.`);
  if(DRY){console.log(JSON.stringify(rows.slice(0,20).map(r=>({iata:r.destination_iata,start:r.event_start,end:r.event_end,name:r.name_en,type:r.event_type,qid:r.source_id})),null,2));return;}
  if(!(await tableReady()))return;
  for(let i=0;i<rows.length;i+=CHUNK){const part=rows.slice(i,i+CHUNK),q=await db.from('destination_events').upsert(part,{onConflict:'source,source_id,destination_iata,event_start'});if(q.error)throw new Error(`Upsert ${i}: ${q.error.message}`);}
  const stale=await db.from('destination_events').update({active:false,updated_at:runAt}).eq('source',WIKIDATA_SOURCE).gte('event_start',window.from).lte('event_start',window.to).lt('last_seen_at',runAt);
  if(stale.error)throw new Error(`Deactivate stale: ${stale.error.message}`);
  const past=await db.from('destination_events').update({active:false,updated_at:runAt}).eq('source',WIKIDATA_SOURCE).lt('event_end',window.from).eq('active',true);
  if(past.error)throw new Error(`Deactivate past: ${past.error.message}`);
  console.log(`Done: ${rows.length} upserted; stale/past rows deactivated; review fields preserved.`);
}
main().catch(e=>{console.error(e);process.exit(1);});
