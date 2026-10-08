import { readHttp400Error } from './http400-diagnostics.mjs';
import { isSuspendedOrigin } from '../src/data/origins.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export class CollectionYield extends Error {
  constructor(message, reason = 'unavailable') { super(message); this.reason = reason; }
}
export class CollectionProvider {
  constructor({ token, lease, clock = Date.now, sleep = delay, fetchImpl = fetch }) {
    this.token = token; this.lease = lease; this.clock = clock; this.sleep = sleep; this.fetchImpl = fetchImpl;
    this.blockedByMethod = new Map();
    this.nextByMethod = new Map(); this.interval = new Map(); this.recent = []; this.requests = 0;
  }
  async request(input, deadline = Infinity, observe = null) {
    const report=(status,reason,diagnostic)=>{try{observe?.(status,reason,diagnostic);}catch{/* Logging cannot affect requests. */}};
    const url = new URL(input);
    if (url.origin !== 'https://api.travelpayouts.com') throw new Error('Unexpected provider origin');
    // Defence in depth for an old durable plan or feedback ticket. Never fabricate empty data.
    if (isSuspendedOrigin(url.searchParams.get('origin'))) return { kind: 'suspended' };
    url.searchParams.delete('token'); // use a header, never a credential-bearing loggable URL
    const method = url.pathname;
    const base = method.includes('month-matrix') ? 250 : 125;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = Math.max(0, (this.nextByMethod.get(method) ?? 0) - this.clock());
      if (this.clock() + wait + 10_000 >= deadline) throw new CollectionYield('Provider unit would cross boundary', wait > 0 && this.blockedByMethod.get(method) ? 'backoff' : 'boundary');
      if (wait) await this.sleep(wait);
      if (!await this.lease()) throw new Error('Provider request forbidden: lease lost');
      if (this.clock()+10000>=deadline) throw new CollectionYield('Lease check consumed provider time budget', 'boundary');
      const requestStarted=this.clock();this.requests++;
      let response;
      try {
        response = await this.fetchImpl(url.href, { headers: { Accept: 'application/json', 'X-Access-Token': this.token }, signal: AbortSignal.timeout(8000) });
      } catch {
        response = null;
      }
      const limit = Number(response?.headers.get('X-Rate-Limit'));
      if (limit > 0) this.interval.set(method, Math.max(base, 60000 / (limit * 0.8)));
      let spacing = this.interval.get(method) ?? base; let quotaWait=0;
      const remaining = response?.headers.get('X-Rate-Limit-Remaining');
      const reset = Number(response?.headers.get('X-Rate-Limit-Reset'));
      if (remaining != null && limit > 0 && Number(remaining) < limit * 0.1) {
        const resetMs = reset > 1e9 ? reset * 1000 - this.clock() : reset * 1000;
        quotaWait = Math.min(65000, Math.max(1000, resetMs || 60000));
      }
      this.nextByMethod.set(method, Math.max(requestStarted + spacing,this.clock()+quotaWait));
      this.blockedByMethod.set(method, quotaWait > 0);
      const refused = !response || response.status === 429 || response.status >= 500;
      this.recent.push(refused); if (this.recent.length > 200) this.recent.shift();
      let diagnostic=null;
      if(response?.status===400 && observe && ((url.searchParams.get('origin')==='HHN'&&url.searchParams.get('destination')==='FRA')
        ||(url.searchParams.get('origin')==='NRN'&&url.searchParams.get('destination')==='DUS')))
        diagnostic=await readHttp400Error(response,{deadline:Math.min(deadline,requestStarted+8000),clock:this.clock,secret:this.token});
      report(response?.status??null,!response?'NETWORK_FAILURE':response.status===429?'RATE_LIMIT':response.status>=500?'HTTP_SERVER_ERROR':response.status>=400?'HTTP_CLIENT_ERROR':null,diagnostic);
      if (this.recent.length === 200 && this.recent.filter(Boolean).length > 100) throw new Error('Provider circuit breaker');
      if (!refused) {
        if (!response.ok) return { kind: 'error', status: response.status };
        try { return { kind: 'ok', json: await response.json() }; }
        catch { report(response.status,'INVALID_JSON');return { kind: 'error', status: response.status }; }
      }
      if (attempt === 2) return { kind: 'refused', refusal: !response ? 'network' : response.status === 429 ? 'tooMany' : 'server' };
      const retryAfter = response?.headers.get('Retry-After');
      const seconds = Number(retryAfter);
      const retryMs = retryAfter == null ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - this.clock();
      const backoff = Math.max([2000, 6000][attempt], Number.isFinite(retryMs) ? Math.min(65000, retryMs) : 0);
      this.nextByMethod.set(method, Math.max(this.nextByMethod.get(method), this.clock() + backoff));
      this.blockedByMethod.set(method, true);
    }
  }
}
