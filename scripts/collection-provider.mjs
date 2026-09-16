const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export class CollectionYield extends Error {}
export class CollectionProvider {
  constructor({ token, lease, clock = Date.now, sleep = delay, fetchImpl = fetch }) {
    this.token = token; this.lease = lease; this.clock = clock; this.sleep = sleep; this.fetchImpl = fetchImpl;
    this.nextByMethod = new Map(); this.interval = new Map(); this.recent = []; this.requests = 0;
  }
  async request(input, deadline = Infinity) {
    const url = new URL(input);
    if (url.origin !== 'https://api.travelpayouts.com') throw new Error('Unexpected provider origin');
    url.searchParams.delete('token'); // use a header, never a credential-bearing loggable URL
    const method = url.pathname;
    const base = method.includes('month-matrix') ? 250 : 125;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = Math.max(0, (this.nextByMethod.get(method) ?? 0) - this.clock());
      if (this.clock() + wait + 10_000 >= deadline) throw new CollectionYield('Provider unit would cross boundary');
      if (wait) await this.sleep(wait);
      if (!await this.lease()) throw new Error('Provider request forbidden: lease lost');
      if (this.clock()+10000>=deadline) throw new CollectionYield('Lease check consumed provider time budget');
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
      const refused = !response || response.status === 429 || response.status >= 500;
      this.recent.push(refused); if (this.recent.length > 200) this.recent.shift();
      if (this.recent.length === 200 && this.recent.filter(Boolean).length > 100) throw new Error('Provider circuit breaker');
      if (!refused) {
        if (!response.ok) return { kind: 'error', status: response.status };
        try { return { kind: 'ok', json: await response.json() }; }
        catch { return { kind: 'error', status: response.status }; }
      }
      if (attempt === 2) return { kind: 'refused', refusal: !response ? 'network' : response.status === 429 ? 'tooMany' : 'server' };
      const retryAfter = response?.headers.get('Retry-After');
      const seconds = Number(retryAfter);
      const retryMs = retryAfter == null ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - this.clock();
      const backoff = Math.max([2000, 6000][attempt], Number.isFinite(retryMs) ? Math.min(65000, retryMs) : 0);
      this.nextByMethod.set(method, Math.max(this.nextByMethod.get(method), this.clock() + backoff));
    }
  }
}
