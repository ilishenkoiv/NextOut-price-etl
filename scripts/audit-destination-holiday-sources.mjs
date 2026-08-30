// Read-only health check for the owner-curated official source manifest.
import { CURATED_DESTINATION_HOLIDAYS } from '../src/data/destination-holidays.js';

const urls=[...new Set(CURATED_DESTINATION_HOLIDAYS.map((entry)=>entry.sourceUrl))];
const results=[];let next=0;
async function worker(){while(next<urls.length){const url=urls[next++],controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30_000);
  try{const response=await fetch(url,{headers:{accept:'text/html,application/pdf;q=0.9,*/*;q=0.5','user-agent':'NextOutHolidaySourceAudit/1.0 (https://nextout.de; kontakt@nextout.de)'},redirect:'follow',signal:controller.signal});
    const state=response.ok?'ok':response.status===401||response.status===403?'manual':response.status===404||response.status===410?'broken':'manual';
    results.push({url,status:response.status,state,finalUrl:response.url,contentType:response.headers.get('content-type')});
  }catch(error){results.push({url,status:0,state:'manual',error:error instanceof Error?error.message:String(error)});}finally{clearTimeout(timer);}}
}
await Promise.all(Array.from({length:Math.min(3,urls.length)},()=>worker()));
results.sort((a,b)=>a.url.localeCompare(b.url));
const summary={sources:urls.length,ok:results.filter((row)=>row.state==='ok').length,manual:results.filter((row)=>row.state==='manual').length,broken:results.filter((row)=>row.state==='broken').length};
console.log(JSON.stringify({...summary,results},null,2));
if(summary.broken)process.exitCode=1;
