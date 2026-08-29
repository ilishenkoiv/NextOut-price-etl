import test from 'node:test';
import assert from 'node:assert/strict';
import { DESTINATIONS } from '../src/data/destinations.js';
import { CITIES } from '../src/data/cities.js';
import { DEST_COORDS } from '../src/data/coords.js';
import { CURATED_DESTINATION_HOLIDAYS } from '../src/data/destination-holidays.js';
import { buildEventQuery, categoryLabels, classifyEvent, isTravelHolidayCandidate, mapConcurrent, rowsFromBindings, rowsFromCuratedHolidays, sixMonthWindow } from './destination-events.mjs';

test('every collected destination has city metadata and centre coordinates',()=>{
  assert.equal(DESTINATIONS.length,139);
  assert.deepEqual(DESTINATIONS.filter(d=>!CITIES[d.iata]||!DEST_COORDS[d.iata]).map(d=>d.iata),[]);
});

test('builds an exact rolling six-month horizon',()=>{
  assert.deepEqual(sixMonthWindow(new Date('2026-08-28T12:00:00Z')),{from:'2026-08-28',to:'2027-02-28'});
});

test('bounded concurrency preserves catalogue order',async()=>{
  let active=0,maxActive=0;
  const result=await mapConcurrent([3,1,2],2,async(value)=>{active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,value));active--;return value*10;});
  assert.deepEqual(result,[30,10,20]);assert.equal(maxActive,2);
});

test('classifies tourist-facing event types',()=>{
  assert.equal(classifyEvent(['Oktoberfest','Volksfest']),'fair');
  assert.equal(classifyEvent(['Cologne Carnival']),'carnival');
  assert.equal(classifyEvent(['Jazz festival']),'music');
  assert.deepEqual(categoryLabels('cultural'),{en:'Cultural event',de:'Kulturveranstaltung'});
});

test('holiday allowlist accepts celebrations and rejects generic events',()=>{
  const row=(name,eventStart='2026-09-20',eventEnd='2026-10-05')=>({name_en:name,name_de:name,type_label_en:'',type_label_de:'',event_start:eventStart,event_end:eventEnd});
  for(const name of ['Oktoberfest','Cologne Carnival','Nuremberg Christmas Market','Festival of Lights','Songkran','FIFA World Cup','Formula 1 Grand Prix','Gamescom','Venice Biennale']){
    assert.equal(isTravelHolidayCandidate(row(name)),true,name);
  }
  for(const name of ['CIBB 2026 conference','InnoTrans 2026','Accelerate Tomorrow AI Summit','Local football match','Regional furniture exhibition']){
    assert.equal(isTravelHolidayCandidate(row(name)),false,name);
  }
  assert.equal(isTravelHolidayCandidate(row('IIHF World Championship','2027-01-01','2027-05-30')),false,'invalid multi-month sports season');
  assert.equal(isTravelHolidayCandidate(row('World Expo 2030','2030-05-01','2030-10-31')),true,'world expo season');
});

test('curated catalogue contains only visible unique concrete editions with official HTTPS sources',()=>{
  const visible=new Set(DESTINATIONS.map((destination)=>destination.iata));
  assert.equal(CURATED_DESTINATION_HOLIDAYS.length,15);
  assert.equal(new Set(CURATED_DESTINATION_HOLIDAYS.map((entry)=>entry.sourceId)).size,CURATED_DESTINATION_HOLIDAYS.length);
  for(const entry of CURATED_DESTINATION_HOLIDAYS){
    assert.ok(visible.has(entry.destinationIata),entry.destinationIata);
    assert.match(entry.sourceUrl,/^https:\/\//);assert.match(entry.eventStart,/^\d{4}-\d{2}-\d{2}$/);assert.ok(entry.eventEnd>=entry.eventStart);
  }
  const rows=rowsFromCuratedHolidays(CURATED_DESTINATION_HOLIDAYS,'2026-08-29T12:00:00Z',{from:'2026-08-29',to:'2027-03-01'});
  assert.equal(rows.length,15);assert.ok(rows.every((row)=>row.source==='official-curated'&&/^[a-f0-9]{64}$/.test(row.content_fingerprint)));
});

test('normalises and deduplicates Wikidata bindings',()=>{
  const binding=(typeEn)=>(
    {event:{value:'http://www.wikidata.org/entity/Q123'},nameEn:{value:'Example Festival'},nameDe:{value:'Beispielfestival'},
      start:{value:'2026-09-20T10:00:00Z'},end:{value:'2026-09-25T22:00:00Z'},type:{value:'http://www.wikidata.org/entity/Q132241'},typeEn:{value:typeEn},
      official:{value:'https://example.test'},placeCoord:{value:'Point(11.58 48.14)'}}
  );
  const holidayBinding=(typeEn)=>({...binding(typeEn),nameEn:{value:'Example Christmas Market'},nameDe:{value:'Beispiel Weihnachtsmarkt'}});
  const rows=rowsFromBindings([holidayBinding('festival'),holidayBinding('cultural festival')],{iata:'MUC',lat:48.137,lon:11.575},'2026-08-28T12:00:00Z');
  assert.equal(rows.length,1);assert.equal(rows[0].source_id,'Q123');assert.equal(rows[0].event_type,'fair');
  assert.equal(rows[0].event_end,'2026-09-25');assert.equal(rows[0].source_license,'CC0-1.0');assert.ok(rows[0].distance_km<2);
  assert.match(rows[0].content_fingerprint,/^[a-f0-9]{64}$/);
});

test('SPARQL is bounded by centre, radius and six-month dates',()=>{
  const q=buildEventQuery({lat:48.137,lon:11.575,from:'2026-08-28',to:'2027-02-28'});
  assert.match(q,/Point\(11\.575 48\.137\)/);assert.match(q,/wikibase:radius "35"/);assert.match(q,/2027-02-28T23:59:59Z/);
});
