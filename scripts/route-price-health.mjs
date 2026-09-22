const DAY = 86_400_000;
export const DEAD_AFTER_DAYS = 30;

// Pure executable model of 20260922120000_route_price_health.sql. Transport/rate-limit/missed
// attempts are explicitly ignored; only a confirmed provider response enters this reducer.
export function recordRouteAttempt(state, attempt) {
  if (!['price','empty'].includes(attempt.outcome)) return structuredClone(state ?? null);
  const at = Number(attempt.at); if (!Number.isFinite(at)) throw new Error('Invalid observation time');
  const horizon=attempt.horizon;if(!Array.isArray(horizon)||horizon.length!==6||new Set(horizon).size!==6
    ||horizon.some(m=>!/^20\d{2}-(0[1-9]|1[0-2])$/.test(m))||!horizon.includes(attempt.month))throw new Error('Invalid horizon');
  const next = structuredClone(state ?? {
    status:'active',firstObservedAt:at,protectedUntil:attempt.isExpansion?at+DEAD_AFTER_DAYS*DAY:null,
    firstConfirmedNoPriceAt:null,lastConfirmedNoPriceAt:null,lastPriceAt:null,
    passId:attempt.passId,observationHorizon:[...horizon],observedMonths:[],passHasPrice:false,
  });
  if(attempt.passId<next.passId)throw new Error('Stale route observation pass');
  if(next.passId!==attempt.passId){next.passId=attempt.passId;next.observationHorizon=[...horizon];next.observedMonths=[];next.passHasPrice=false;}
  else if(JSON.stringify(next.observationHorizon)!==JSON.stringify(horizon))throw new Error('Horizon changed within pass');
  if(!next.observedMonths.includes(attempt.month))next.observedMonths.push(attempt.month);
  const hasPrice=attempt.outcome==='price';next.passHasPrice ||= hasPrice;
  if(hasPrice){next.status='active';next.firstConfirmedNoPriceAt=null;next.lastPriceAt=at;return next;}
  if(next.observedMonths.length===6){
    if(next.passHasPrice){next.status='active';next.firstConfirmedNoPriceAt=null;}
    else{
      next.firstConfirmedNoPriceAt ??= at;next.lastConfirmedNoPriceAt=at;
      const protectedUntil=next.protectedUntil??next.firstObservedAt;
      if(at-next.firstConfirmedNoPriceAt>=DEAD_AFTER_DAYS*DAY&&at>=protectedUntil)next.status='dead';
    }
  }
  return next;
}

export function reviveRoute(state,{at}){
  const next=structuredClone(state);if(!next)return null;
  next.status='active';next.firstConfirmedNoPriceAt=null;next.lastPriceAt=at;return next;
}
