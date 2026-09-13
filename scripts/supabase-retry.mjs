const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
// PostgREST drops response headers from its result. Preserve Retry-After on errors for
// our bounded retry loop, and give every database request an explicit time limit.
export async function retryMetadataFetch(input,init={},request=fetch) {
  const timeout=AbortSignal.timeout(20000);
  const signal=init.signal?AbortSignal.any([init.signal,timeout]):timeout;
  const response=await request(input,{...init,signal});
  const retryAfter=response.headers.get('retry-after');
  if(response.ok||!retryAfter)return response;
  const body=await response.text();let error;
  try{error=JSON.parse(body);}catch{error={message:body};}
  if(!error||typeof error!=='object'||Array.isArray(error))error={message:body};
  const headers=new Headers(response.headers);
  headers.delete('content-length');headers.delete('content-encoding');headers.set('content-type','application/json');
  return new Response(JSON.stringify({...error,retryAfter}),{status:response.status,statusText:response.statusText,headers});
}
export function isTransientSupabaseFailure(error,status) {
  const code=String(error?.code??'');
  return [408,429,500,502,503,504,520,521,522,523,524,525,526,530].includes(Number(status??code))
    || ['40001','40P01','57014','ECONNRESET','ETIMEDOUT','EAI_AGAIN','ENOTFOUND'].includes(code)
    || /timeout|timed out|fetch failed|network|dns resolution|gateway|temporarily unavailable|connection reset/i.test(String(error?.message??''));
}
// Only use for reads or idempotent upsert/update/delete operations. Build the query anew each time.
export function retryAfterMs(value,now=Date.now()) {
  if(value==null||value==='')return 0;
  const seconds=Number(value);
  return Math.max(0,Number.isFinite(seconds)?seconds*1000:(Date.parse(value)-now)||0);
}
export async function withSupabaseRetry(operation,{label='Supabase operation',delays=[1000,3000,8000],sleep=delay,warn=console.warn,random=Math.random,now=Date.now}={}) {
  for(let attempt=0;;attempt++){
    let result;
    try {
      const request=operation();
      // Avoid multiplying the SDK's own retries by the explicit attempts below.
      if(typeof request?.retry==='function')request.retry(false);
      result=await request;
    }
    catch(error){
      const transient=isTransientSupabaseFailure(error);
      if(attempt>=delays.length||!transient){warn(`${label}: failed after ${attempt+1} attempts; ${transient?'transport retries exhausted':'permanent transport failure'}`);throw error;}
      const wait=delays[attempt]+Math.round(delays[attempt]*0.25*random());
      warn(`${label}: transport failure; attempt ${attempt+1}/${delays.length+1}; retry in ${wait}ms`);
      await sleep(wait);continue;
    }
    if(!result?.error){if(attempt)warn(`${label}: recovered on attempt ${attempt+1}/${delays.length+1}`);return result;}
    const transient=isTransientSupabaseFailure(result.error,result.status);
    // Only log status and classification: error messages can contain URLs or credentials.
    const status=Number(result.status)||'unknown';
    if(attempt>=delays.length||!transient){warn(`${label}: HTTP ${status}; failed after ${attempt+1} attempts; ${transient?'retries exhausted':'permanent error'}`);return result;}
    const requested=retryAfterMs(result.headers?.get?.('retry-after')??result.error.retryAfter,now());
    // Do not retry earlier than a provider asks, or keep a worker asleep indefinitely.
    if(requested>60000){warn(`${label}: HTTP ${status}; Retry-After exceeds worker wait budget; deferred`);return result;}
    const wait=Math.max(requested,delays[attempt]+Math.round(delays[attempt]*0.25*random()));
    warn(`${label}: HTTP ${status}; attempt ${attempt+1}/${delays.length+1}; retry in ${wait}ms`);
    await sleep(wait);
  }
}
export function canCheckpointWindow(outcomes){
  return [...outcomes].every(outcome=>outcome==='found'||outcome==='empty');
}
