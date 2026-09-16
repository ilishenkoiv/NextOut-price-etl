// Service-role-only durable state. The SQL functions compare owner + fencing
// token atomically, so an old runner cannot replace a new runner's checkpoint.
export class CollectionStore {
  constructor(db, owner, runId) { this.db = db; this.owner = owner; this.runId = runId; this.token = null; this.renewedAt = 0; this.plans = new Map(); }
  async rpc(name, args = {}) {
    const { data, error } = await this.db.rpc(name, args);
    if (error) throw new Error(`Collection storage operation failed: ${name} (${error.code ?? 'unknown'})`);
    return data;
  }
  async inspect() { return this.rpc('collection_state_inspect'); }
  async claim(previousOwner = null) {
    const result = await this.rpc('collection_state_claim', {
      p_owner: this.owner, p_run_id: this.runId, p_previous_owner: previousOwner,
    });
    if (!result?.token) throw new Error('Another collection runner owns the lease');
    this.token = result.token;
    return result.state;
  }
  args() { return { p_owner: this.owner, p_token: this.token }; }
  async lease() {
    if (this.token == null) return false;
    if (Date.now() - this.renewedAt < 15_000) return true;
    const ok = await this.rpc('collection_state_renew', this.args()) === true;
    if (ok) this.renewedAt = Date.now();
    return ok;
  }
  async plan(key, build) {
    if (!/^coordinator\/[a-z]+-\d+-\d+\.json$/.test(key)) throw new Error('Invalid plan key');
    if (this.plans.has(key)) return this.plans.get(key);
    if (!await this.lease()) throw new Error('Plan read forbidden: lease lost');
    const bucket = this.db.storage.from('price-snapshots');
    const found = await bucket.download(key);
    if (!found.error) {
      const value = JSON.parse(await found.data.text()); this.plans.set(key, value); return value;
    }
    if (!['404', '400'].includes(String(found.error.statusCode)) || !/not found|not exist/i.test(found.error.message ?? '')) throw new Error('Cannot read durable collection plan');
    const value = await build();
    if (!await this.lease()) throw new Error('Plan write forbidden: lease lost');
    const saved = await bucket.upload(key, JSON.stringify(value), { contentType: 'application/json', upsert: false });
    if (saved.error) throw new Error('Cannot save durable collection plan');
    this.plans.set(key, value); return value;
  }
  async save(state) {
    if (!await this.rpc('collection_state_save', { ...this.args(), p_state: state })) throw new Error('Checkpoint rejected: collection lease lost');
  }
  async release() { return this.rpc('collection_state_release', this.args()); }
}

export async function oldRunnerHasStopped(previous, { repository, token, fetchImpl = fetch, now = Date.now() }) {
  if (!previous?.owner) return true;
  if (!/^\d+$/.test(String(previous.run_id ?? '')) || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !token) return false;
  // Wait beyond request timeouts after the last lease. Never infer that a job
  // died only from a missing heartbeat or failed GitHub response.
  if (now - Date.parse(previous.lease_until) < 30_000) return false;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/runs/${previous.run_id}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return false;
    return (await response.json()).status === 'completed';
  } catch { return false; }
}
