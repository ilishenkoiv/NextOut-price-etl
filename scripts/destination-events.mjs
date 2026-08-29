import { createHash } from 'node:crypto';

export const WIKIDATA_SOURCE = 'wikidata';
export const WIKIDATA_LICENSE = 'CC0-1.0';

// Discovery is deliberately narrow. This product is a carousel of globally recognisable
// celebrations/holiday periods, NOT a generic city-event feed. A row outside this editorial
// allowlist never reaches the owner queue, even if Wikidata classifies it as an event.
const TRAVEL_HOLIDAY_PATTERNS = [
  /oktoberfest|beer festival|bierfest/,
  /christmas market|weihnachtsmarkt|christkindl(?:es)?markt|advent market/,
  /carnival|karneval|fasching|fastnacht|mardi gras/,
  /new year|silvester|lunar new year|chinese new year|spring festival/,
  /festival of lights|light festival|lantern festival|lichterfest/,
  /folk festival|volksfest|city festival|stadtfest/,
  /harvest festival|wine festival|weinfest/,
  /cherry blossom|hanami/,
  /day of the dead|d[ií]a de (?:los )?muertos/,
  /songkran|holi|diwali|la tomatina|las fallas|san ferm[ií]n/,
  /berlinale|hafengeburtstag/,
];

const MAJOR_WORLD_SPORT_PATTERNS = [
  /olympic games|olympics|olympische spiele/,
  /fifa world cup|fu[sß]ball-weltmeisterschaft/,
  /uefa euro(?:pean championship)?|fu[sß]ball-europameisterschaft/,
  /champions league final/,
  /formula (?:1|one)|formel 1|grand prix/,
  /wimbledon|tour de france|super bowl/,
  /world championship|weltmeisterschaft/,
];

const MAJOR_WORLD_EXHIBITION_PATTERNS = [
  /world expo|expo \d{4}/,
  /gamescom|art basel|venice biennale|biennale di venezia|documenta/,
  /frankfurt book fair|frankfurter buchmesse/,
  /mobile world congress|ces \d{4}|iaa mobility/,
  /berlinale/,
];

function durationDays(start, end) {
  const parse=(value)=>{const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value||'');return m?Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3])):NaN;};
  const a=parse(start),b=parse(end);return Number.isFinite(a)&&Number.isFinite(b)?Math.floor((b-a)/86_400_000)+1:Infinity;
}

export function isTravelHolidayCandidate(row) {
  const text=[row.name_en,row.name_de,row.type_label_en,row.type_label_de].filter(Boolean).join(' ').toLocaleLowerCase();
  const days=durationDays(row.event_start,row.event_end);
  // Long festival periods such as Oktoberfest/Christmas markets are valid. Selected world-scale
  // sport can run a little longer; a truly global Expo/Biennale may span a season. Generic
  // conferences, trade fairs, matches and exhibitions still never enter the queue.
  if(days<=45&&TRAVEL_HOLIDAY_PATTERNS.some((pattern)=>pattern.test(text)))return true;
  if(days<=45&&MAJOR_WORLD_SPORT_PATTERNS.some((pattern)=>pattern.test(text)))return true;
  return days<=210&&MAJOR_WORLD_EXHIBITION_PATTERNS.some((pattern)=>pattern.test(text));
}

const CATEGORY_LABELS = {
  festival: { en:'Festival', de:'Festival' },
  carnival: { en:'Carnival', de:'Karneval' },
  fair: { en:'Fair or market', de:'Fest oder Markt' },
  music: { en:'Music event', de:'Musikveranstaltung' },
  sports: { en:'Sports event', de:'Sportveranstaltung' },
  cultural: { en:'Cultural event', de:'Kulturveranstaltung' },
  public_holiday: { en:'Public holiday', de:'Feiertag' },
  other: { en:'Special event', de:'Besonderes Ereignis' },
};

export function ymd(date) { return date.toISOString().slice(0,10); }

export function sixMonthWindow(now = new Date()) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from);
  to.setUTCMonth(to.getUTCMonth() + 6);
  return { from:ymd(from), to:ymd(to) };
}

export function classifyEvent(labels = []) {
  const text = labels.join(' ').toLocaleLowerCase();
  if (/carnival|karneval|karnevalsumzug|mardi gras|fasching|fastnacht/.test(text)) return 'carnival';
  if (/christmas market|weihnachtsmarkt|fair|market|messe|folk festival|volksfest|oktoberfest/.test(text)) return 'fair';
  if (/music|concert|opera|jazz|rock|orchestra|musik|konzert/.test(text)) return 'music';
  if (/sport|football|soccer|marathon|race|championship|cup|tournament|olympic/.test(text)) return 'sports';
  if (/festival/.test(text)) return 'festival';
  if (/culture|cultural|art|film|theatre|theater|light|museum|kultur|kunst/.test(text)) return 'cultural';
  if (/public holiday|national day|feiertag|independence day/.test(text)) return 'public_holiday';
  return 'other';
}

export function categoryLabels(category) { return CATEGORY_LABELS[category] ?? CATEGORY_LABELS.other; }

export async function mapConcurrent(items, limit, mapper) {
  const width=Math.max(1,Math.min(items.length||1,Math.trunc(limit)||1));
  const results=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:width},async()=>{
    while(true){const index=next++;if(index>=items.length)return;results[index]=await mapper(items[index],index);}
  }));
  return results;
}

export function haversineKm(aLat, aLon, bLat, bLon) {
  const rad = (n) => n * Math.PI / 180;
  const dLat=rad(bLat-aLat), dLon=rad(bLon-aLon);
  const x=Math.sin(dLat/2)**2 + Math.cos(rad(aLat))*Math.cos(rad(bLat))*Math.sin(dLon/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}

export function pointFromWkt(value) {
  const m=/Point\(([-\d.]+)\s+([-\d.]+)\)/i.exec(value||'');
  return m ? { lon:Number(m[1]), lat:Number(m[2]) } : null;
}

export function wikidataEventId(uri) { return /\/(Q\d+)$/.exec(uri||'')?.[1] ?? ''; }

export function eventContentFingerprint(row) {
  return createHash('sha256').update([row.name_en,row.name_de,row.event_type,row.event_start,row.event_end,row.official_url||'',row.source_type_id||''].join('|')).digest('hex');
}

export function rowsFromCuratedHolidays(entries, runAt, window) {
  return entries.filter((entry)=>entry.eventEnd>=window.from&&entry.eventStart<=window.to).map((entry)=>{
    const labels=categoryLabels(entry.eventType);
    const row={
      source:'official-curated',source_id:entry.sourceId,destination_iata:entry.destinationIata,
      name_en:entry.nameEn,name_de:entry.nameDe,event_type:entry.eventType,
      type_label_en:labels.en,type_label_de:labels.de,event_start:entry.eventStart,event_end:entry.eventEnd,
      official_url:entry.sourceUrl,source_url:entry.sourceUrl,source_license:'Official source; factual dates',
      source_type_id:null,latitude:null,longitude:null,distance_km:null,date_confidence:'exact',
      needs_translation:false,active:true,last_seen_at:runAt,updated_at:runAt,
    };
    row.content_fingerprint=eventContentFingerprint(row);return row;
  });
}

export function buildEventQuery({ lat, lon, from, to, radiusKm=35, limit=200 }) {
  return `PREFIX wd: <http://www.wikidata.org/entity/>\nPREFIX wdt: <http://www.wikidata.org/prop/direct/>\nPREFIX wikibase: <http://wikiba.se/ontology#>\nPREFIX bd: <http://www.bigdata.com/rdf#>\nPREFIX geo: <http://www.opengis.net/ont/geosparql#>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\nSELECT DISTINCT ?event ?nameEn ?nameDe ?start ?end ?official ?type ?typeEn ?typeDe ?placeCoord WHERE {\n  SERVICE wikibase:around {\n    ?place wdt:P625 ?placeCoord .\n    bd:serviceParam wikibase:center "Point(${Number(lon)} ${Number(lat)})"^^geo:wktLiteral .\n    bd:serviceParam wikibase:radius "${Number(radiusKm)}" .\n  }\n  ?event wdt:P31/wdt:P279* wd:Q1656682 .\n  { ?event wdt:P580 ?start . } UNION { ?event wdt:P585 ?start . }\n  { ?event wdt:P276 ?place . } UNION { ?event wdt:P131 ?place . }\n  FILTER(?start >= "${from}T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>)\n  FILTER(?start <= "${to}T23:59:59Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>)\n  OPTIONAL { ?event wdt:P582 ?end . }\n  OPTIONAL { ?event wdt:P856 ?official . }\n  OPTIONAL { ?event wdt:P31 ?type . }\n  OPTIONAL { ?event rdfs:label ?nameEn FILTER(LANG(?nameEn)="en") }\n  OPTIONAL { ?event rdfs:label ?nameDe FILTER(LANG(?nameDe)="de") }\n  OPTIONAL { ?type rdfs:label ?typeEn FILTER(LANG(?typeEn)="en") }\n  OPTIONAL { ?type rdfs:label ?typeDe FILTER(LANG(?typeDe)="de") }\n}\nLIMIT ${Math.max(1,Math.trunc(limit))}`;
}

function bindingValue(binding, key) { return binding?.[key]?.value ?? null; }

export function rowsFromBindings(bindings, destination, runAt) {
  const grouped=new Map();
  for(const b of bindings||[]) {
    const sourceId=wikidataEventId(bindingValue(b,'event'));
    const start=bindingValue(b,'start')?.slice(0,10);
    if(!sourceId || !/^\d{4}-\d{2}-\d{2}$/.test(start||'')) continue;
    const key=`${sourceId}|${start}`;
    const g=grouped.get(key) ?? { sourceId,start,ends:new Set(),namesEn:new Set(),namesDe:new Set(),typesEn:new Set(),typesDe:new Set(),typeIds:new Set(),officials:new Set(),points:[] };
    const add=(set,value)=>{if(value)set.add(value);};
    add(g.ends,bindingValue(b,'end')?.slice(0,10)); add(g.namesEn,bindingValue(b,'nameEn')); add(g.namesDe,bindingValue(b,'nameDe'));
    add(g.typesEn,bindingValue(b,'typeEn')); add(g.typesDe,bindingValue(b,'typeDe')); add(g.typeIds,wikidataEventId(bindingValue(b,'type'))); add(g.officials,bindingValue(b,'official'));
    const point=pointFromWkt(bindingValue(b,'placeCoord')); if(point)g.points.push(point);
    grouped.set(key,g);
  }
  const rows=[];
  for(const g of grouped.values()) {
    const nameEn=[...g.namesEn][0] ?? [...g.namesDe][0] ?? g.sourceId;
    const nameDe=[...g.namesDe][0] ?? nameEn;
    const typeLabels=[...g.typesEn,...g.typesDe]; const eventType=classifyEvent([nameEn,nameDe,...typeLabels]);
    const labels=categoryLabels(eventType); const point=g.points[0] ?? {lat:destination.lat,lon:destination.lon};
    const eventEnd=[...g.ends].sort().at(-1) ?? g.start;
    const row={
      source:WIKIDATA_SOURCE, source_id:g.sourceId, destination_iata:destination.iata,
      name_en:nameEn, name_de:nameDe, event_type:eventType, type_label_en:labels.en, type_label_de:labels.de,
      event_start:g.start, event_end:eventEnd, official_url:[...g.officials][0] ?? null,
      source_url:`https://www.wikidata.org/wiki/${g.sourceId}`, source_license:WIKIDATA_LICENSE,
      source_type_id:[...g.typeIds][0] || null, latitude:point.lat, longitude:point.lon,
      distance_km:Math.round(haversineKm(destination.lat,destination.lon,point.lat,point.lon)*10)/10,
      date_confidence:'exact', needs_translation:g.namesEn.size===0 || g.namesDe.size===0,
      active:true, last_seen_at:runAt, updated_at:runAt,
    };
    row.content_fingerprint=eventContentFingerprint(row);
    if(isTravelHolidayCandidate(row)) rows.push(row);
  }
  return rows.sort((a,b)=>a.event_start.localeCompare(b.event_start)||a.destination_iata.localeCompare(b.destination_iata)||a.source_id.localeCompare(b.source_id));
}
