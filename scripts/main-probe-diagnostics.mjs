const CELLS=new Set([1370,1992,4740,5362,8110,8732]);
export const isTargetMainCell=(jobId,cellId)=>jobId===20732&&CELLS.has(cellId);
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
  const seen=new Set();let emitted=0,suppressed=0,flushed=false;
  const output=value=>{try{emit(value);}catch{/* Diagnostics never alter provider/checkpoint execution. */}};
  return{
    record(context,reason,httpStatus){
      if(!isTargetMainCell(context?.jobId,context?.cellId)||!REASONS.has(reason)
        ||!['direct','any'].includes(context.variant)||!/^[A-Z]{3}$/.test(context.origin??'')||!/^[A-Z]{3}$/.test(context.dest??'')
        ||!/^\d{4}-(0[1-9]|1[0-2])$/.test(context.departureMonth??'')||!/^\d{4}-(0[1-9]|1[0-2])$/.test(context.returnMonth??''))return;
      const key=[context.cellId,context.variant,context.departureMonth,context.returnMonth].join('|');
      if(seen.has(key))return;seen.add(key);
      if(emitted>=cap){suppressed++;return;}
      emitted++;
      output({event:'main_required_probe_failure',source:sourceSha,runId:run,jobId:20732,cellId:context.cellId,
        origin:context.origin,dest:context.dest,departureMonth:context.departureMonth,returnMonth:context.returnMonth,variant:context.variant,
        httpStatus:Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599?httpStatus:null,reason});
    },
    flush(){if(flushed)return;flushed=true;if(suppressed)output({event:'main_required_probe_suppression',source:sourceSha,runId:run,jobId:20732,emitted,suppressed,limit:cap});},
  };
}
