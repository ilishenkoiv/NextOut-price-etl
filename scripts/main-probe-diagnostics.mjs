import { safeProviderError } from './http400-diagnostics.mjs';
// Context comes from the admitted immutable plan, not provider data. Cover the two
// routes throughout this job's existing cells; never broaden to other jobs/routes.
const TARGET_JOB=20733,TARGET_TOTAL=16362;
export const isTargetMainCell=(jobId,cellId,origin,dest)=>jobId===TARGET_JOB
  &&Number.isSafeInteger(cellId)&&cellId>=0&&cellId<TARGET_TOTAL
  &&(origin==='HHN'&&dest==='FRA'||origin==='NRN'&&dest==='DUS');
const REASONS=new Set(['HTTP_CLIENT_ERROR','HTTP_SERVER_ERROR','RATE_LIMIT','NETWORK_FAILURE','INVALID_JSON',
  'SUCCESS_NOT_TRUE','DATA_NOT_ARRAY','PROVIDER_REFUSED','UNKNOWN_PROVIDER_FAILURE']);
export function requiredProbeFailureReason(response){
  if(response?.kind!=='ok'){
    if(response?.status===429||response?.refusal==='tooMany')return 'RATE_LIMIT';
    if(response?.status>=500||response?.refusal==='server')return 'HTTP_SERVER_ERROR';
    if(response?.status>=400&&response?.status<500)return 'HTTP_CLIENT_ERROR';
    if(response?.refusal==='network')return 'NETWORK_FAILURE';
    return response?.kind==='refused'?'PROVIDER_REFUSED':'UNKNOWN_PROVIDER_FAILURE';
  }
  // Mirror the existing required-probe classifier's truthiness contract exactly.
  if(!response.json?.success)return 'SUCCESS_NOT_TRUE';
  if(!Array.isArray(response.json.data))return 'DATA_NOT_ARRAY';
  return null;
}
export function createMainProbeDiagnostics({source,runId,emit=record=>console.log(JSON.stringify(record)),limit=24}={}){
  const sourceSha=/^[a-f0-9]{40}$/.test(source??'')?source:null;
  const run=/^\d{1,24}$/.test(String(runId??''))?String(runId):null;
  const cap=Math.max(0,Math.min(24,Number.isSafeInteger(limit)?limit:24));
  const seen=new Set(),providerSeen=new Set();let emitted=0,suppressed=0,flushed=false,providerEmitted=0;
  const output=value=>{try{emit(value);}catch{/* Diagnostics never alter provider/checkpoint execution. */}};
  return{
    recordProviderError(context,diagnostic){
      if(!Number.isSafeInteger(context?.jobId)||context.jobId<0||!Number.isSafeInteger(context.cellId)||context.cellId<0
        ||!(context.origin==='HHN'&&context.dest==='FRA'||context.origin==='NRN'&&context.dest==='DUS')
        ||!['direct','any'].includes(context.variant)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(context.departureMonth??'')
        ||!/^\d{4}-(0[1-9]|1[0-2])$/.test(context.returnMonth??''))return;
      const safe=safeProviderError({code:diagnostic?.providerCode,message:diagnostic?.providerMessage});
      if(!safe)return;
      const key=[context.jobId,context.cellId,context.variant,context.departureMonth,context.returnMonth].join('|');
      if(providerSeen.has(key)||providerEmitted>=cap)return;
      providerSeen.add(key);providerEmitted++;
      output({event:'main_http400_provider_error',source:sourceSha,runId:run,jobId:context.jobId,cellId:context.cellId,
        origin:context.origin,dest:context.dest,departureMonth:context.departureMonth,returnMonth:context.returnMonth,
        variant:context.variant,httpStatus:400,reason:'HTTP_CLIENT_ERROR',...safe});
    },
    record(context,reason,httpStatus){
      if(!isTargetMainCell(context?.jobId,context?.cellId,context?.origin,context?.dest)||!REASONS.has(reason)
        ||!['direct','any'].includes(context.variant)||!/^[A-Z]{3}$/.test(context.origin??'')||!/^[A-Z]{3}$/.test(context.dest??'')
        ||!/^\d{4}-(0[1-9]|1[0-2])$/.test(context.departureMonth??'')||!/^\d{4}-(0[1-9]|1[0-2])$/.test(context.returnMonth??''))return;
      const key=[context.cellId,context.variant,context.departureMonth,context.returnMonth].join('|');
      if(seen.has(key))return;seen.add(key);
      if(emitted>=cap){suppressed++;return;}
      emitted++;
      output({event:'main_required_probe_failure',source:sourceSha,runId:run,jobId:TARGET_JOB,cellId:context.cellId,
        origin:context.origin,dest:context.dest,departureMonth:context.departureMonth,returnMonth:context.returnMonth,variant:context.variant,
        httpStatus:Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599?httpStatus:null,reason});
    },
    flush(){if(flushed)return;flushed=true;if(suppressed)output({event:'main_required_probe_suppression',source:sourceSha,runId:run,jobId:TARGET_JOB,emitted,suppressed,limit:cap});},
  };
}
