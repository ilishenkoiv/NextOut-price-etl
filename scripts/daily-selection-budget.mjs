// Shared cap for the selected-ticket point-refresh pass. The coordinator also keeps a separate
// session reserve; the standalone recovery publisher must finish this pass completely or fail
// before publishing.
export const DAILY_SELECTION_REFRESH_MAX_MS = 10 * 60_000;
export const DAILY_SELECTION_REFRESH_RESERVE_MS = 5 * 60_000;
