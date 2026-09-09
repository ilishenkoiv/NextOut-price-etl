import test from 'node:test';
import assert from 'node:assert/strict';
import {roundTripOffers,monthlyQuoteProvenance,augmentDailyPriority,priorityWatchRouteKeys} from './quote-integrity.mjs';
import {fetchFlightMonth,fetchCalendarMonth} from './fetch-prices.mjs';
import {planWindowDestinations} from './window-destination-plan.mjs';
const round={departure_at:'2027-01-01',return_at:'2027-01-08',nights:7,price:710,flight_type:'any'};
test('one country watch expands only collection priorities, not stored watch records',()=>{
  const rows=[{origin:'MUC',dest:'ATH',watch_scope:'country',country_code:'GR'}];
  const keys=priorityWatchRouteKeys(rows);
  assert.ok(keys.includes('MUC|ATH'));assert.ok(keys.includes('MUC|SKG'));assert.ok(!keys.includes('MUC|BCN'));
  assert.equal(rows.length,1);
});
test('window collector checks selected exotic/watch destinations every day',()=>{
  for(let day=1;day<=7;day++){
    const p=planWindowDestinations({allDests:['AAA','LGK','HKT','BCN'],findCount:new Map([['AAA',20]]),
      planDate:`2026-09-0${day}`,topCount:1,priorityDests:['LGK','HKT','BCN']});
    assert.deepEqual(new Set(p.selected),new Set(['AAA','LGK','HKT','BCN']));
  }
});
test('one-way389 never undercuts round-trip710',()=>{
  const offers=roundTripOffers([{...round,return_at:null,nights:null,price:389},round]);
  assert.equal(Math.min(...offers.map(o=>o.price)),710);
  assert.equal(monthlyQuoteProvenance(offers,710).sample_offer.nights,7);
});
test('both actual collector paths reject one-way before calculating min',async()=>{
  const v3=await fetchFlightMonth('MUC','LGK','2027-01',false,'2027-01',async url=>{
    assert.equal(new URL(url).searchParams.get('one_way'),'false');
    return {kind:'ok',json:{success:true,data:[{...round,return_at:null,price:389},round]}};
  });
  assert.equal(v3.min,710);assert.equal(v3.offers.length,1);
  const cal=await fetchCalendarMonth('MUC','LGK','2027-01',async url=>{
    assert.equal(new URL(url).searchParams.get('one_way'),'false');
    return {kind:'ok',json:{success:true,data:[
      {depart_date:'2027-01-01',return_date:null,value:389},
      {depart_date:'2027-01-01',return_date:'2027-01-08',value:710},
    ]}};
  });
  assert.equal(cal.min,710);assert.equal(cal.offers.length,1);
});
test('invalid dates, reversed dates and mismatched duration are rejected',()=>{
  for(const patch of [{return_at:'2027-02-30'},{return_at:'2026-12-31'},{nights:5},{price:0}])
    assert.equal(roundTripOffers([{...round,...patch}]).length,0);
});
test('priority exotic and active watch routes bypass dead slice without duplication',()=>{
  const routes=['LGK','BCN','LIS'].map(dest=>({origin:'MUC',dest,key:`MUC|${dest}`}));
  const p=augmentDailyPriority({live:[],dead:routes,probed:[routes[0]],slice:2},new Set(['MUC|BCN']));
  assert.deepEqual(p.probed.map(r=>r.dest),['LGK','BCN']);
});
