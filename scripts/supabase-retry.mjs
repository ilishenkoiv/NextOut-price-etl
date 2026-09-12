const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
export function isTransientSupabaseFailure(error,status) {
  const code=String(error?.code??'');
  return [408,429,500,502,503,504,520,521,522,523,524,525,526,530].includes(Number(status??code))
    || ['40001','40P01','57014','ECONNRESET','ETIMEDOUT','EAI_AGAIN','ENOTFOUND'].includes(code)
    || /timeout|timed out|fetch failed|network|dns resolution|gateway|temporarily unavailable|connection reset/i.test(String(error?.message??''));
}
// Only use for reads or idempotent upsert/update/delete operations. Build the query anew each time.
export async function withSupabaseRetry(operation,{label='Supabase operation',delays=[1000,3000,8000],sleep=delay,warn=console.warn}={}) {
  for(let attempt=0;;attempt++){
    let result;
    try { result=await operation(); }
    catch(error){
      if(attempt>=delays.length||!isTransientSupabaseFailure(error))throw error;
      warn(label+': transient transport failure; retry '+(attempt+1)+'/'+delays.length);
      await sleep(delays[attempt]);continue;
    }
    if(!result?.error||attempt>=delays.length||!isTransientSupabaseFailure(result.error,result.status))return result;
    warn(label+': transient database failure; retry '+(attempt+1)+'/'+delays.length);
    await sleep(delays[attempt]);
  }
}
export function canCheckpointWindow(outcomes){
  return [...outcomes].every(outcome=>outcome==='found'||outcome==='empty');
}
