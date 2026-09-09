const realDay = value => {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const ms=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===value;
};
export function validRoundTrip(offer) {
  if(!realDay(offer.departure_at)||!realDay(offer.return_at)||!Number.isFinite(offer.price)||offer.price<=0)return false;
  const nights=(Date.parse(offer.return_at)-Date.parse(offer.departure_at))/86400000;
  return nights>=1 && Number.isInteger(nights) && offer.nights===nights;
}
export function roundTripOffers(offers){return offers.filter(validRoundTrip);}
export function monthlyQuoteProvenance(offers,min){
  const sample=roundTripOffers(offers).find(o=>o.price===min);
  return {round_trip_validated:true,...(sample?{sample_offer:{departure_at:sample.departure_at,
    return_at:sample.return_at,nights:sample.nights,price:sample.price,flight_type:sample.flight_type}}:{})};
}
export const PRIORITY_EXOTIC_DESTINATIONS = ['LGK','KBV','HKT','DPS','MLE','SEZ'];
export function isPriorityRoute(route, watchRoutes=new Set()) {
  return PRIORITY_EXOTIC_DESTINATIONS.includes(route.dest)||watchRoutes.has(route.key);
}
export function augmentDailyPriority(plan, watchRoutes) {
  const selected=new Map(plan.probed.map(r=>[r.key,r]));
  for(const route of plan.dead)if(isPriorityRoute(route,watchRoutes))selected.set(route.key,route);
  return {...plan,probed:[...selected.values()]};
}
import { WATCH_COUNTRY_DESTINATIONS } from '../src/data/watch-country-destinations.js';
export function priorityWatchRouteKeys(rows){
  return [...new Set(rows.flatMap(row=>{
    const destinations=row.watch_scope==='country'?WATCH_COUNTRY_DESTINATIONS.filter(d=>d.cc===row.country_code).map(d=>d.iata):[row.dest];
    return destinations.filter(dest=>dest&&dest!==row.origin).map(dest=>`${row.origin}|${dest}`);
  }))];
}
