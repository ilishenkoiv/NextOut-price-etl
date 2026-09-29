const realMonth=value=>typeof value==='string'&&/^\d{4}-\d{2}$/.test(value);
const realDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)
  &&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;

function sampleDates(source,price,flightType){
  const sample=source?.sample_offer;
  if(!sample||!realDay(sample.departure_at)||!realDay(sample.return_at)||sample.return_at<=sample.departure_at
    ||Number(sample.price)!==price||flightType==='direct'&&sample.flight_type&&sample.flight_type!=='direct')return null;
  return{departure_at:sample.departure_at,return_at:sample.return_at};
}

export function buildCarouselSixMonthMinimum(ticket,monthlyRows,horizon){
  if(!Array.isArray(horizon)||horizon.length!==6||new Set(horizon).size!==6||!horizon.every(realMonth))return null;
  const priceField=ticket.flight_type==='direct'?'direct':'any_stops';
  const variants=monthlyRows.filter(row=>row.origin===ticket.origin&&row.dest===ticket.dest&&horizon.includes(row.month))
    .map(row=>({row,price:Number(row[priceField])})).filter(entry=>entry.price>0&&Number.isFinite(Date.parse(entry.row.updated_at)))
    .sort((a,b)=>a.price-b.price||String(b.row.updated_at).localeCompare(String(a.row.updated_at))||a.row.month.localeCompare(b.row.month));
  const winner=variants[0];if(!winner)return null;
  const variantSource=winner.row.price_source?.variants?.[ticket.flight_type]??winner.row.price_source??null;
  const sample=sampleDates(variantSource,winner.price,ticket.flight_type);
  return{price:winner.price,currency:'EUR',winning_month:winner.row.month,horizon_start:horizon[0],horizon_end:horizon.at(-1),
    source:'prices',observed_at:winner.row.updated_at,
    ...(typeof winner.row.price_source?.run_id==='string'?{source_run_id:winner.row.price_source.run_id}:{}),
    ...(sample?{sample_dates:sample}:{})};
}

export function attachCarouselSixMonthMinimum(tickets,monthlyRows,horizon){return tickets.map(ticket=>{
  const minimum=buildCarouselSixMonthMinimum(ticket,monthlyRows,horizon);if(!minimum)return ticket;
  return{...ticket,price_source:{...(ticket.price_source??{}),carousel_six_month_min:minimum}};
});}

export function preserveCarouselSixMonthMinimum(nextExactSource,previousSource){
  const minimum=previousSource?.carousel_six_month_min;
  return minimum?{...(nextExactSource??{}),carousel_six_month_min:minimum}:nextExactSource??null;
}

// Callers supply candidates in their approved order (Dream -> Would-return -> other where those
// personal tiers exist, deterministic exact-ticket price order in the shared publication). This
// contract only applies diversity: another exact-price-qualified city first, then the first item
// in that same order as an explicit last-resort repeat. A six-month minimum never qualifies a row.
export function chooseCarouselCityForWindow(orderedEligible,usedCities){
  const priced=orderedEligible.filter(row=>Number(row.exact_price)>0);if(!priced.length)return null;
  const different=priced.find(row=>!usedCities.has(row.dest));
  return different?{candidate:different,repeat:false,reason:'different_city'}:
    {candidate:priced[0],repeat:true,reason:'last_resort_no_different_eligible_city'};
}
