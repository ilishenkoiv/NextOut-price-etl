// Pure retention helpers shared by the quarterly storage cleanup and its unit tests.

export const SNAPSHOT_RETENTION_DAYS = 365;
export const PROGRESS_RETENTION_DAYS = 35;

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const SNAPSHOT_KEY = /^snapshots\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})_\d{4}_[^/]+\.csv\.gz$/;

function parsedUtc(ymd) {
  const match = YMD.exec(String(ymd));
  if (!match) return null;
  const [, y, m, d] = match;
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
  return new Date(ms).toISOString().slice(0, 10) === ymd ? ms : null;
}

export function retentionCutoff(todayYmd, retentionDays) {
  const today = parsedUtc(todayYmd);
  if (today == null || !Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error('retentionCutoff requires a real YYYY-MM-DD date and a positive whole-day retention');
  }
  return new Date(today - retentionDays * 86400000).toISOString().slice(0, 10);
}

export function snapshotDateFromKey(key) {
  const match = SNAPSHOT_KEY.exec(String(key));
  if (!match) return null;
  const [, folderYear, folderMonth, date] = match;
  if (date.slice(0, 4) !== folderYear || date.slice(5, 7) !== folderMonth) return null;
  return parsedUtc(date) == null ? null : date;
}

export function shouldDeleteSnapshot(key, cutoffYmd) {
  const date = snapshotDateFromKey(key);
  return date != null && date < cutoffYmd;
}

export function positiveDays(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Retention must be a positive integer, received: ${value}`);
  }
  return parsed;
}
