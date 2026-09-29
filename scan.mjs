// Escáner de mercado de Albion World (v2).
//
// Cada corrida, por región (las 3 en paralelo, cada una es otro host de AODP):
//   1. Precios actuales de TODO el catálogo: 3.694 ítems + variantes encantadas = 9.638 ids × 8 ciudades.
//   2. Promedio de 30 días de TODAS las ciudades de TODOS los ítems, refrescado en rotación: cada
//      corrida renueva una porción (todo el catálogo cada ~24 h; más rápido mientras falte cobertura)
//      y lo guarda en `state/<region>.json.gz`.
//   3. Análisis: transporte, gangas vs su promedio, crafteo (226 recetas × T4-T8 × .0-.4) y
//      refinado (5 recursos × T4-T8 × .0-.4).
//   4. Escribe `out/<region>.json` (lo lee la app) y `out/status.json` (salud de cada región).
//
//   node scan.mjs                        # las 3 regiones
//   node scan.mjs americas               # una región
//   node scan.mjs americas --limit 400   # prueba rápida con los primeros 400 ids
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CITIES, HOSTS, createClient } from './lib/aodp.mjs';
import { craftDeals, indexPrices, marketDeals, refineDeals, robustAverage, parseDate, transportRoutes } from './lib/analyze.mjs';
import { readJson, writeJson } from './lib/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'out');
const STATE = path.join(here, 'state');
const BASELINE_DAYS = 30;
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

/** Estado: { v, cursor, avg: { "<id>|<ciudad#>": [promedio, día] }, refreshed: { id: día } }. */
function loadState(region, log) {
  const s = readJson(path.join(STATE, `${region}.json.gz`), null, log);
  if (s?.v === 1 && s.avg && s.refreshed) return s;
  return { v: 1, cursor: 0, avg: {}, refreshed: {} };
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
    series = await client.history(pending, BASELINE_DAYS);
  } catch (err) {
    log(`historial: ${err.message} (se reintenta en la próxima corrida)`);
    return { refreshed: 0, coverage };
  }
  const cutoff = Date.now() - BASELINE_DAYS * 86400e3;
  for (const entry of series) {
    const ci = cityIndex.get(entry?.location);
    if (ci === undefined || typeof entry.item_id !== 'string') continue;
    const ts = entry.data?.timestamps ?? [];
    const prices = (entry.data?.prices_avg ?? []).filter((_, k) => (parseDate(ts[k]) || 0) >= cutoff);
    const avg = robustAverage(prices);
    const key = `${entry.item_id}|${ci}`;
    if (avg) state.avg[key] = [Math.round(avg), day];
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
  writeJson(path.join(STATE, `${region}.json.gz`), state);

  const now = Date.now();
  const index = indexPrices(rows, now);
  const day = today();
  const avgOf = (id, city) => {
    const hit = state.avg[`${id}|${cityIndex.get(city)}`];
    return hit && day - hit[1] <= AVG_MAX_AGE_DAYS ? hit[0] : null;
  };
  const transport = transportRoutes(index, now);
  const market = marketDeals(index, avgOf, now);
  const craft = craftDeals(index, catalog.recipes, catalog.craftReturnRate, now);
  const refine = refineDeals(index, catalog.refining, now);

  const payload = {
    v: 2,
    region,
    generatedAt: new Date().toISOString(),
    baselineDays: BASELINE_DAYS,
    items: ids.length,
    cities: CITIES.length,
    transport: transport.list,
    market: market.list,
    craft: craft.list,
    refine: refine.list,
  };
  const bytes = writeJson(path.join(OUT, `${region}.json`), payload);
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
    candidates: { transport: transport.candidates, market: market.candidates, craft: craft.candidates, refine: refine.candidates },
    published: { transport: transport.list.length, market: market.list.length, craft: craft.list.length, refine: refine.list.length },
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
