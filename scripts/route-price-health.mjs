const DAY = 86_400_000;
export const PERMANENT_DEAD_AFTER_DAYS = 7;
export const TEMPORARY_DEAD_CUTOFF = Date.parse('2026-09-28T22:00:00Z'); // 2026-09-29 00:00 Europe/Berlin
export const TEMPORARY_DEAD_POLICY = 'temporary_immediate';
export const PERMANENT_DEAD_POLICY = 'permanent_7d';

export function routeIsEffectivelyDead(row,instant){
  if(row?.status!=='dead')return false;
  const parsed=Date.parse(row.temporary_dead_until??''),cutoff=Number.isFinite(parsed)?parsed:TEMPORARY_DEAD_CUTOFF;
  return row.dead_policy!==TEMPORARY_DEAD_POLICY||instant<cutoff;
}

// Pure executable model of 20260922120000_route_price_health.sql. Transport/rate-limit/missed
// attempts are explicitly ignored; only a confirmed provider response enters this reducer.
export function recordRouteAttempt(state, attempt) {
  if (!['price','empty'].includes(attempt.outcome)) return structuredClone(state ?? null);
  const at = Number(attempt.at); if (!Number.isFinite(at)) throw new Error('Invalid observation time');
  const horizon=attempt.horizon;if(!Array.isArray(horizon)||horizon.length!==6||new Set(horizon).size!==6
    ||horizon.some(m=>!/^20\d{2}-(0[1-9]|1[0-2])$/.test(m))||!horizon.includes(attempt.month))throw new Error('Invalid horizon');
  const next = structuredClone(state ?? {
    status:'active',deadPolicy:null,temporaryDeadUntil:null,firstObservedAt:at,protectedUntil:attempt.isExpansion?at+30*DAY:null,
    firstConfirmedNoPriceAt:null,lastConfirmedNoPriceAt:null,lastPriceAt:null,
    passId:attempt.passId,observationHorizon:[...horizon],observedMonths:[],passHasPrice:false,
  });
  if(attempt.passId<next.passId)throw new Error('Stale route observation pass');
  if(next.status==='dead'&&next.deadPolicy===TEMPORARY_DEAD_POLICY&&at>=(next.temporaryDeadUntil??TEMPORARY_DEAD_CUTOFF)){
    const permanentEligible=next.firstConfirmedNoPriceAt!=null
      &&at-next.firstConfirmedNoPriceAt>=PERMANENT_DEAD_AFTER_DAYS*DAY
      &&at>=(next.protectedUntil??next.firstObservedAt);
    next.status=permanentEligible?'dead':'active';next.deadPolicy=permanentEligible?PERMANENT_DEAD_POLICY:null;
    next.temporaryDeadUntil=null;
  }
  if(next.passId!==attempt.passId){next.passId=attempt.passId;next.observationHorizon=[...horizon];next.observedMonths=[];next.passHasPrice=false;}
  else if(JSON.stringify(next.observationHorizon)!==JSON.stringify(horizon))throw new Error('Horizon changed within pass');
  if(!next.observedMonths.includes(attempt.month))next.observedMonths.push(attempt.month);
  const hasPrice=attempt.outcome==='price';next.passHasPrice ||= hasPrice;
  if(attempt.isExpansion&&next.protectedUntil==null)next.protectedUntil=next.firstObservedAt+30*DAY;
  if(hasPrice){next.status='active';next.deadPolicy=null;next.temporaryDeadUntil=null;
    next.firstConfirmedNoPriceAt=null;next.lastPriceAt=at;return next;}
  if(next.observedMonths.length===6){
    if(next.passHasPrice){next.status='active';next.deadPolicy=null;next.temporaryDeadUntil=null;next.firstConfirmedNoPriceAt=null;}
    else{
      next.firstConfirmedNoPriceAt ??= at;next.lastConfirmedNoPriceAt=at;
      const protectedUntil=next.protectedUntil??next.firstObservedAt;
      if(at<TEMPORARY_DEAD_CUTOFF){next.status='dead';next.deadPolicy=TEMPORARY_DEAD_POLICY;
        next.temporaryDeadUntil=TEMPORARY_DEAD_CUTOFF;}
      else if(at-next.firstConfirmedNoPriceAt>=PERMANENT_DEAD_AFTER_DAYS*DAY&&at>=protectedUntil){
        next.status='dead';next.deadPolicy=PERMANENT_DEAD_POLICY;next.temporaryDeadUntil=null;
      }else{next.status='active';next.deadPolicy=null;next.temporaryDeadUntil=null;}
    }
  }
  return next;
}

export function reviveRoute(state,{at}){
  const next=structuredClone(state);if(!next)return null;
  next.status='active';next.deadPolicy=null;next.temporaryDeadUntil=null;
  next.firstConfirmedNoPriceAt=null;next.lastPriceAt=at;return next;
}
