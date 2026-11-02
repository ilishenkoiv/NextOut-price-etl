// Private JSON checkpoint extension. Identity does not depend on a rebuilt plan's indexes.
export const mainCellKey = cell => `${cell.origin}|${cell.dest}|${cell.month}`;

export function retainUnidentifiedHistory(cp, history = []) {
  const unknown = new Map((cp.unidentifiedOutstanding ?? []).map(item => [item.passId, item]));
  for (const pass of history) {
    if (!Array.isArray(pass.outstanding) && (pass.outcomes?.unresolved ?? 0) > 0)
      unknown.set(pass.id, { passId: pass.id, count: pass.outcomes.unresolved });
  }
  cp.unidentifiedOutstanding = [...unknown.values()];
}

export function normalizeOutstanding(cells = []) {
  const unique = new Map();
  for (const cell of cells) {
    if (!/^[A-Z]{3}$/.test(cell.origin ?? '') || !/^[A-Z]{3}$/.test(cell.dest ?? '')
      || !/^\d{4}-\d{2}$/.test(cell.month ?? '') || !Array.isArray(cell.horizon))
      throw new Error('Invalid outstanding MAIN context');
    const key = mainCellKey(cell), previous = unique.get(key);
    // Keep the oldest original context, but retain each pass that owed this cell.
    unique.set(key, { ...(previous ?? structuredClone(cell)),
      passIds: [...new Set([...(previous?.passIds ?? []), ...(cell.passIds ?? [])])],
      cellIds: { ...(previous?.cellIds ?? {}), ...(cell.cellIds ?? {}) } });
  }
  return [...unique.values()];
}

export function retainMainCell(cp, plan, cellId, job, wave) {
  const route = plan.routes[cellId % plan.routes.length];
  const month = plan.months[Math.floor(cellId / plan.routes.length)];
  if (!route || !month) throw new Error('Unresolved MAIN cell absent from original plan');
  cp.outstanding = normalizeOutstanding([...(cp.outstanding ?? []), {
    origin: route.origin, dest: route.dest, month, horizon: [...plan.months],
    breakKeys: [...(plan.breakKeys ?? [])], wave, passIds: [job.id], planDate: job.planDate,
    status: 'pending', attempts: 0, cellIds: { [job.id]: cellId },
  }]);
}

export function mainSuccessorCheckpoint(current) {
  const cp = current.checkpoint ?? {};
  const unknown = cp.unidentifiedOutstanding ?? [];
  const missing = Math.max(0, (cp.outcomes?.unresolved ?? 0) - (cp.unresolvedCells?.length ?? 0));
  const unmapped = (cp.unresolvedCells ?? []).filter(id => !(cp.outstanding ?? [])
    .some(cell => cell.cellIds?.[current.id] === id));
  return { cursor: 0, errors: 0, outstanding: normalizeOutstanding(cp.outstanding),
    legacyUnresolved: [...(cp.legacyUnresolved ?? []), ...(unmapped.length ? [{ id: current.id,
      planDate: current.planDate, wave: cp.wave ?? 0, cellIds: unmapped }] : [])],
    unidentifiedOutstanding: missing ? [...unknown, { passId: current.id, count: missing }] : [...unknown],
    // One carry attempt first; a boundary after it forces normal work on the next unit.
    carryTurn: true };
}
