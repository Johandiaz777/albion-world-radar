// Escáner de mercado de Albion World (v2).
//
// Cada corrida, por región (las 3 en paralelo, cada una es otro host de AODP):
//   1. Precios actuales de TODO el catálogo: 3.694 ítems + variantes encantadas = 9.638 ids × 8 ciudades.
//   2. Promedio de 30 días de TODAS las ciudades de TODOS los ítems, refrescado en rotación: cada
//      corrida renueva una porción (todo el catálogo cada ~24 h; más rápido mientras falte cobertura)
//      y lo guarda en `state/<region>.json.gz`.
//   3. Análisis de las 6 tarjetas del Radar: transporte, gangas vs su promedio de 30 y de 7 días
//      ("Cayó fuerte"), crafteo (226 recetas × T4-T8 × .0-.4), refinado (5 recursos × T4-T8 × .0-.4),
//      cosecha (15 cultivos) y cría (44 animales/tiers).
//   4. Historial diario de precios: `history/<region>/<fecha>.json.gz`, un archivo por día cerrado.
//   5. Escribe `out/<region>.json` (lo lee la app) y `out/status.json` (salud de cada región).
//
//   node scan.mjs                        # las 3 regiones
//   node scan.mjs americas               # una región
//   node scan.mjs americas --limit 400   # prueba rápida con los primeros 400 ids
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CITIES, HOSTS, createClient } from './lib/aodp.mjs';
import {
  breedDeals,
  craftDeals,
  farmDeals,
  indexPrices,
  itemValues,
  marketDeals,
  mostTraded,
  parseDate,
  refineDeals,
  robustAverage,
  seriesStats,
  transportRoutes,
  trendMovers,
} from './lib/analyze.mjs';
import { readJson, writeJson } from './lib/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'out');
const HISTORY = path.join(here, 'history');
const STATE = path.join(here, 'state');
const BASELINE_DAYS = 30;
// La API guarda el precio diario de cada ítem por meses: se piden 180 días en la misma rotación, así
// "Cayó fuerte" de 90/180 días, tendencias y proyecciones existen desde el primer día.
const HISTORY_DAYS = 180;
const AVG_MAX_AGE_DAYS = 3; // un promedio de más de 3 días no se usa
const RUNS_PER_DAY = 48; // cada 30 min
const BOOTSTRAP_SLICE = 3000; // ids por corrida mientras falte cobertura

const catalog = readJson(path.join(here, 'catalog.json'), null);
if (!catalog?.ids?.length) {
  console.error('catalog.json falta o está dañado: regénéralo con scripts/export-radar-catalog.mjs de la app');
  process.exit(1);
}
const args = process.argv.slice(2);
const regions = args.filter((a) => HOSTS[a]).length ? args.filter((a) => HOSTS[a]) : Object.keys(HOSTS);
const limitAt = args.indexOf('--limit');
const ids = limitAt >= 0 ? catalog.ids.slice(0, Number(args[limitAt + 1])) : catalog.ids;
const cityIndex = new Map(CITIES.map((c, i) => [c, i]));
const today = () => Math.floor(Date.now() / 86400e3);

/**
 * Estado por región:
 * - `avg`: { "<id>|<ciudad#>": [prom. 30 d, día del cálculo, prom. 7 d, prom. 90 d, prom. 180 d,
 *          tendencia % (14 d contra los 14 anteriores), unidades vendidas en 7 d, proyección a 7 d] }
 *   (0 = sin dato suficiente)
 * - `refreshed`: { id: día } — cuándo se pidió por última vez su historial
 * - `days`: { "YYYY-MM-DD": { "<id>|<ciudad#>": precio medio del día } } — buffer del historial diario:
 *   un día se cierra (se escribe su archivo en `history/`) cuando ya pasaron 2 días, así todos los ids
 *   (que se refrescan en rotación a lo largo de 24 h) alcanzaron a aportar su punto de ese día.
 */
function loadState(region, log) {
  const s = readJson(path.join(STATE, `${region}.json.gz`), null, log);
  if (s?.v === 1 && s.avg && s.refreshed) return { days: {}, ...s };
  return { v: 1, cursor: 0, avg: {}, refreshed: {}, days: {} };
}

/** Escribe los días cerrados como archivos `history/<region>/<fecha>.json.gz` (solo se agregan, nunca
 * se reescriben) y los saca del buffer. Devuelve cuántos días cerró. */
function flushClosedDays(region, state) {
  const limit = new Date((today() - 2) * 86400e3).toISOString().slice(0, 10);
  let closed = 0;
  for (const date of Object.keys(state.days).sort()) {
    if (date > limit) continue;
    const file = path.join(HISTORY, region, `${date}.json.gz`);
    if (Object.keys(state.days[date]).length) {
      writeJson(file, { v: 1, region, date, cities: CITIES, prices: state.days[date] });
      closed += 1;
    }
    delete state.days[date];
  }
  return closed;
}

async function refreshAverages(client, state, log) {
  const day = today();
  const fresh = ids.filter((id) => day - (state.refreshed[id] ?? -999) <= 1).length;
  const coverage = fresh / ids.length;
  const slice = coverage < 0.9 ? BOOTSTRAP_SLICE : Math.ceil(ids.length / RUNS_PER_DAY) + 10;
  // Primero los que nunca se refrescaron o están más viejos; el cursor rota el resto.
  const pending = [];
  for (let k = 0; k < ids.length && pending.length < slice; k++) {
    const id = ids[(state.cursor + k) % ids.length];
    if (day - (state.refreshed[id] ?? -999) >= 1) pending.push(id);
  }
  state.cursor = (state.cursor + slice) % ids.length;
  if (!pending.length) return { refreshed: 0, coverage };
  let series = [];
  try {
    series = await client.history(pending, HISTORY_DAYS);
  } catch (err) {
    log(`historial: ${err.message} (se reintenta en la próxima corrida)`);
    return { refreshed: 0, coverage };
  }
  // Historial diario: solo el punto de AYER (el de hoy todavía cambia). Cada id se refresca una vez
  // por día, así que durante el día X todos aportan su punto de X-1, que se cierra en X+1.
  const yesterday = new Date((day - 1) * 86400e3).toISOString().slice(0, 10);
  for (const entry of series) {
    const ci = cityIndex.get(entry?.location);
    if (ci === undefined || typeof entry.item_id !== 'string') continue;
    const ts = entry.data?.timestamps ?? [];
    const prices = entry.data?.prices_avg ?? [];
    const counts = entry.data?.item_count ?? [];
    const key = `${entry.item_id}|${ci}`;
    const points = [];
    ts.forEach((raw, k) => {
      const t = parseDate(raw);
      if (Number.isFinite(t) && prices[k] > 0) points.push({ t, price: prices[k], count: counts[k] ?? 0 });
      if (prices[k] > 0 && typeof raw === 'string' && raw.slice(0, 10) === yesterday) (state.days[yesterday] ??= {})[key] = Math.round(prices[k]);
    });
    const st = seriesStats(points, Date.now());
    if (st.avg30) state.avg[key] = [st.avg30, day, st.avg7, st.avg90, st.avg180, st.trendPct, st.volume7, st.projection7];
    else delete state.avg[key];
  }
  for (const id of pending) state.refreshed[id] = day;
  // Limpieza: ids que ya no están en el catálogo y promedios vencidos.
  const known = new Set(ids);
  for (const key of Object.keys(state.avg)) {
    const [id] = key.split('|');
    if (!known.has(id) || day - state.avg[key][1] > AVG_MAX_AGE_DAYS) delete state.avg[key];
  }
  for (const id of Object.keys(state.refreshed)) if (!known.has(id)) delete state.refreshed[id];
  const newCoverage = ids.filter((id) => day - (state.refreshed[id] ?? -999) <= 1).length / ids.length;
  return { refreshed: pending.length, coverage: newCoverage };
}

async function scanRegion(region) {
  const t0 = Date.now();
  const notes = [];
  const log = (msg) => {
    notes.push(msg);
    console.log(`[${region}] ${msg}`);
  };
  const client = createClient(region);
  const state = loadState(region, log);

  const { rows, failedChunks } = await client.prices(ids, log);
  if (!rows.length) throw new Error('AODP no devolvió precios');
  const averages = await refreshAverages(client, state, log);
  const closedDays = flushClosedDays(region, state);
  if (closedDays) log(`historial diario: ${closedDays} día(s) cerrado(s)`);
  writeJson(path.join(STATE, `${region}.json.gz`), state);

  const now = Date.now();
  const index = indexPrices(rows, now);
  const day = today();
  const avgOf = (slot) => (id, city) => {
    const hit = state.avg[`${id}|${cityIndex.get(city)}`];
    return hit && day - hit[1] <= AVG_MAX_AGE_DAYS ? hit[slot] || null : null;
  };
  /** Estadísticas vigentes por ítem-ciudad, para tendencias y "más movidos". */
  const statsOf = (id, city) => {
    const hit = state.avg[`${id}|${cityIndex.get(city)}`];
    return hit && day - hit[1] <= AVG_MAX_AGE_DAYS ? { avg30: hit[0], trendPct: hit[5] ?? 0, volume7: hit[6] ?? 0, projection7: hit[7] ?? 0 } : null;
  };
  const transport = transportRoutes(index, now);
  const market = marketDeals(index, avgOf(0), now);
  // "Cayó fuerte" de 7 días: lo mismo contra el promedio de la última semana.
  const drops7 = marketDeals(index, avgOf(2), now);
  const drops90 = marketDeals(index, avgOf(3), now);
  const drops180 = marketDeals(index, avgOf(4), now);
  const trends = trendMovers(index, statsOf, CITIES);
  const traded = mostTraded(index, statsOf, CITIES);
  const craft = craftDeals(index, catalog.recipes, catalog.craftReturnRate, now);
  const refine = refineDeals(index, catalog.refining, now);
  const farm = farmDeals(index, catalog.farm, now);
  const breed = breedDeals(index, catalog.farm, now);

  const payload = {
    v: 2,
    region,
    generatedAt: new Date().toISOString(),
    baselineDays: BASELINE_DAYS,
    items: ids.length,
    cities: CITIES.length,
    transport: transport.list,
    market: market.list,
    drops7: drops7.list,
    drops90: drops90.list,
    drops180: drops180.list,
    rising: trends.rising,
    falling: trends.falling,
    mostTraded: traded.list,
    craft: craft.list,
    refine: refine.list,
    farm: farm.list,
    breed: breed.list,
  };
  const bytes = writeJson(path.join(OUT, `${region}.json`), payload);
  // Resumen para la pantalla del Radar: lo mejor de cada tarjeta (~3 KB). La lista completa solo se
  // baja al tocar "Ver más" o "Cayó fuerte".
  const firsts = (list, n = 3) => list.slice(0, n);
  writeJson(path.join(OUT, `${region}-top.json`), {
    v: 2,
    region,
    generatedAt: payload.generatedAt,
    baselineDays: BASELINE_DAYS,
    items: ids.length,
    cities: CITIES.length,
    transport: firsts(payload.transport),
    market: firsts(payload.market),
    craft: firsts(payload.craft),
    refine: firsts(payload.refine),
    farm: firsts(payload.farm),
    breed: firsts(payload.breed),
  });
  // Valor de mercado por ítem (para estimar el botín de cada kill en el scraper de kills y en la
  // app): mediana entre ciudades del promedio de 30 días; si no hay, mediana de la venta fresca.
  const values = itemValues(ids, avgOf(0), index, CITIES);
  writeJson(path.join(OUT, `values-${region}.json`), { v: 1, region, generatedAt: payload.generatedAt, p: values });
  const status = {
    ok: true,
    at: payload.generatedAt,
    seconds: Math.round((Date.now() - t0) / 1000),
    requests: client.stats.requests,
    retries: client.stats.retries,
    rateLimited: client.stats.rateLimited,
    downloadedMB: Math.round(client.stats.bytes / 1e5) / 10,
    rows: rows.length,
    lostChunks: failedChunks,
    freshItems: [...index.values()].filter((e) => e.sells.length || e.buys.length).length,
    averageCoverage: Math.round(averages.coverage * 1000) / 10,
    averagesRefreshed: averages.refreshed,
    candidates: { transport: transport.candidates, market: market.candidates, drops7: drops7.candidates, drops90: drops90.candidates, drops180: drops180.candidates, trends: trends.candidates, mostTraded: traded.candidates, craft: craft.candidates, refine: refine.candidates, farm: farm.candidates, breed: breed.candidates },
    published: { transport: transport.list.length, market: market.list.length, drops7: drops7.list.length, drops90: drops90.list.length, drops180: drops180.list.length, rising: trends.rising.length, falling: trends.falling.length, mostTraded: traded.list.length, craft: craft.list.length, refine: refine.list.length, farm: farm.list.length, breed: breed.list.length },
    historyDaysClosed: closedDays,
    outputKB: Math.round(bytes / 102.4) / 10,
    notes: notes.slice(-10),
  };
  console.log(`[${region}] ${JSON.stringify({ ...status, notes: undefined })}`);
  return status;
}

const previous = readJson(path.join(OUT, 'status.json'), { regions: {} });
const results = await Promise.allSettled(regions.map(scanRegion));
const statusFile = { generatedAt: new Date().toISOString(), catalogItems: ids.length, regions: { ...previous.regions } };
let failures = 0;
results.forEach((r, k) => {
  const region = regions[k];
  if (r.status === 'fulfilled') statusFile.regions[region] = r.value;
  else {
    failures += 1;
    // El archivo anterior de esa región se conserva (el workflow lo trajo de la rama `data`); la
    // app ve su fecha y vuelve a su lista fija si pasa de 2 h.
    const last = previous.regions?.[region] ?? {};
    statusFile.regions[region] = { ...last, ok: false, failedAt: new Date().toISOString(), error: String(r.reason?.message ?? r.reason) };
    console.error(`[${region}] FALLÓ: ${r.reason?.message ?? r.reason}`);
  }
});
writeJson(path.join(OUT, 'status.json'), statusFile);
if (failures === regions.length) process.exit(1);
