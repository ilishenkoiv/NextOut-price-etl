// Only complete, committed traversal/retry work permits another bounded MAIN unit.
export function mainBoundaryStatus(before, after, reason = 'unavailable', requiredProbeFailed = false) {
  const advanced = (after.cursor ?? 0) > (before.cursor ?? 0)
    || (after.retryAttempts ?? 0) > (before.retryAttempts ?? 0);
  return reason === 'boundary' && !requiredProbeFailed && advanced && (after.errors ?? 0) === (before.errors ?? 0)
    ? 'progress' : 'yield';
}
