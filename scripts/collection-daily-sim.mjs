// Discrete-event simulation harness for the daily-main guarantee. It DRIVES the real
// SequentialSchedule (collection-schedule.mjs) across simulated GitHub-Actions sessions, so SLOTS
// allocation, the 24h main cycle, mainAtRisk and the tail-yields-to-main change are exercised for
// real. No network, no secrets, no imports of production adapters — stub adapters advance a shared
// virtual clock and per-task cursors by (unit minutes × cells/min). Used by tests AND by the
// dry-run rollout step (`node scripts/collection-daily-sim.mjs`).
import { SequentialSchedule, freshScheduleState, MAIN_CYCLE_MS } from './collection-schedule.mjs';

export const MIN = 60_000;
export const DAY = 24 * 60 * MIN;
export const SESSION_MIN = 235;   // measured successful session length (audit 2026-09-20)
const SETUP_MIN = 2;              // checkout + npm ci before collection starts
const MAIN_UNIT_MS = 30_000;      // one bounded main unit (adapters.mjs unitEnd = clock+30s)
const TAIL_UNIT_MS = 30_000;
const FAST_UNIT_MS = 5_000;
const MAINT_UNIT_MS = 2_000;

function makeHandlers(ctx, rate, total) {
  const adv = (ms) => { ctx.now += ms; };
  const cells = (ms, perMin) => Math.max(1, Math.round((ms / MIN) * perMin));
  const stepper = (unitMs, perMin, totKey) => async ({ job }) => {
    const cp = job.checkpoint ?? { cursor: 0, total: total[totKey], errors: 0, wave: ctx.wave };
    const cursor = Math.min(cp.total, cp.cursor + cells(unitMs, perMin));
    adv(unitMs);
    return { status: cursor >= cp.total ? 'done' : 'progress', checkpoint: { ...cp, cursor } };
  };
  return {
    fast: { maxUnitMs: FAST_UNIT_MS, step: stepper(FAST_UNIT_MS, rate.fast, 'fast') },
    main: { maxUnitMs: MAIN_UNIT_MS, step: stepper(MAIN_UNIT_MS, rate.main, 'main') },
    tail: { maxUnitMs: TAIL_UNIT_MS, step: stepper(TAIL_UNIT_MS, rate.tail, 'tail') },
    maintenance: { maxUnitMs: MAINT_UNIT_MS, step: async () => { adv(MAINT_UNIT_MS); return { status: 'empty' }; } },
  };
}

// Evenly spread `sessions` cron slots across the day (minute-of-day). `7 */4 * * *` is 6/day; a
// lower number models GitHub dropping/serializing overlapping runs + the transient-DB session loss.
export function cronOffsets(sessions) {
  return Array.from({ length: sessions }, (_, i) => Math.round(i * (1440 / sessions)) + 7);
}

// Returns time from the wave-N main pass start (job.startedAt) to main.done. dbFailAt={day,session}
// injects ONE transient save() failure that aborts that session (production 00:0x UTC behavior).
export async function simulate({ guaranteeDailyMain, sessions, mainTotal, mainRate, tailRate = 24,
  fastRate = 200, maxDays = 8, dbFailAt = null }) {
  const ctx = { now: 0, wave: 43 };
  const state = freshScheduleState();
  const handlers = makeHandlers(ctx, { main: mainRate, tail: tailRate, fast: fastRate }, { main: mainTotal, tail: 900_000, fast: 400 });
  let dbArmed = !!dbFailAt;
  const save = async () => {
    if (dbArmed && dbFailAt && ctx._day === dbFailAt.day && ctx._sess === dbFailAt.session) {
      dbArmed = false; throw new Error('Collection database operation failed');
    }
  };
  const engine = new SequentialSchedule({ state, clock: () => ctx.now, lease: async () => true, save, handlers, guaranteeDailyMain });
  const cron = cronOffsets(sessions);
  let passStart = null, doneAt = null, sessionsRun = 0, dbFailures = 0;
  for (let day = 0; day < maxDays && doneAt === null; day++) {
    for (let s = 0; s < cron.length && doneAt === null; s++) {
      const sStart = day * DAY + cron[s] * MIN;
      if (sStart < ctx.now) continue;
      ctx.now = sStart + SETUP_MIN * MIN; ctx._day = day; ctx._sess = s;
      engine.stopAt = sStart + SESSION_MIN * MIN;
      sessionsRun++;
      let guard = 0;
      while (ctx.now < engine.stopAt && doneAt === null && guard++ < 1_000_000) {
        let r;
        try { r = await engine.tick(); }
        catch { dbFailures++; break; }                 // transient DB / lease → session lost
        const mj = engine.state.jobs.main;
        if (mj?.checkpoint?.cursor > 0 && passStart === null) passStart = mj.startedAt;
        if (mj?.done) { doneAt = ctx.now; break; }
        if (r.status === 'idle') ctx.now += 1 * MIN;
      }
    }
  }
  return { doneAt, passStart, elapsedMs: doneAt != null ? doneAt - passStart : null, sessionsRun, dbFailures };
}

export const hrs = (ms) => ms == null ? null : +(ms / (60 * MIN)).toFixed(2);
export const reserveOf = (elapsedMs) => elapsedMs == null ? -1 : +(1 - elapsedMs / MAIN_CYCLE_MS).toFixed(3);

// Dry-run: `node scripts/collection-daily-sim.mjs` prints the sessions-per-day curve for wave-43.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const WAVE43 = 17_800, RATE = 24;
  console.log('wave-43 (182 dest) main pass, ~24 cells/min realized, 1 transient DB failure/day:');
  for (const mode of [false, true]) {
    for (const sessions of [3, 4, 5, 6]) {
      const r = await simulate({ guaranteeDailyMain: mode, sessions, mainTotal: WAVE43, mainRate: RATE, dbFailAt: { day: 0, session: Math.min(sessions - 1, 2) } });
      console.log(`  tailYield=${mode?'on ':'off'} sessions=${sessions}: ${hrs(r.elapsedMs)}h  reserve=${(reserveOf(r.elapsedMs)*100).toFixed(0)}%  ${r.elapsedMs!=null&&r.elapsedMs<=MAIN_CYCLE_MS?'≤24h OK':'>24h'}`);
    }
  }
}
