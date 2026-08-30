export const DESTINATION_REQUEST_RETENTION_MONTHS = 24;

export function calendarMonthsAgoIso(nowValue, months = DESTINATION_REQUEST_RETENTION_MONTHS) {
  const now = new Date(nowValue);
  if (Number.isNaN(now.getTime())) throw new TypeError('nowValue must be a valid date');
  if (!Number.isInteger(months) || months <= 0) throw new TypeError('months must be a positive integer');

  const targetMonthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth() - months;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastTargetDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(now.getUTCDate(), lastTargetDay);

  const target = new Date(now);
  target.setUTCFullYear(targetYear, targetMonth, targetDay);
  return target.toISOString();
}
