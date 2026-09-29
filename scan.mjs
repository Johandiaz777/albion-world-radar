// Escáner de mercado de Albion World.
// Cada corrida pide a AODP (Albion Online Data Project) los precios de TODO el catálogo comerciable
// en las 8 ciudades de mercado y escribe UN json pequeño por región (`out/<region>.json`) que la app
// lee directo por HTTPS. Sin dependencias ni secretos: Node 20+ (fetch nativo).
//
//   node scan.mjs                 # las 3 regiones
//   node scan.mjs americas        # una región
//   node scan.mjs americas --limit 300   # prueba rápida con los primeros 300 ítems
//
// Qué publica (formato v1, lo lee `src/services/radar-scan.ts` de la app):
// - `transport`: comprar donde está más barato y vender a la mejor orden de compra de otra ciudad.
//   Precios brutos: la app calcula la ganancia con SU impuesto (Premium del juego o no).
// - `market`: ciudad donde un ítem está más barato que SU propio promedio de 30 días. Se eligen
//   candidatos por precio frente a las otras ciudades y se confirman con el historial diario real
//   (mismo promedio robusto que `robustAveragePrice` de la app).
import fs from 'node:fs';
import path from 'node:path';

const HOSTS = {
  americas: 'https://west.albion-online-data.com',
  europe: 'https://europe.albion-online-data.com',
  asia: 'https://east.albion-online-data.com',
};
const CITIES = ['Caerleon', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien', 'Black Market'];
const IDS_PER_PRICE_REQUEST = 100;
const IDS_PER_HISTORY_REQUEST = 50;
// ~85 pedidos/min: por debajo del límite de AODP (180/min y 300 cada 5 min). Cada región es otro host.
const REQUEST_GAP_MS = 700;
const HEADERS = { 'User-Agent': 'AlbionWorld-radar/1.0 (+https://github.com/Johandiaz777/albion-world-radar)' };
const RANK_TAX = 0.04; // solo para ORDENAR; la app recalcula con el impuesto del usuario
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // más viejo que 12 h no es una oportunidad real
const MIN_PRICE = 50; // AODP devuelve órdenes de 1-2 de plata como relleno
const BASELINE_DAYS = 30;
const MARKET_CANDIDATES = 300;
const TOP_TRANSPORT = 150;
const TOP_TRANSPORT_ROI = 50;
const TOP_MARKET = 150;

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ids = JSON.parse(fs.readFileSync(path.join(here, 'item-ids.json'), 'utf8'));
const args = process.argv.slice(2);
const regions = args.filter((a) => HOSTS[a]).length ? args.filter((a) => HOSTS[a]) : Object.keys(HOSTS);
const limitArg = args.indexOf('--limit');
const catalog = limitArg >= 0 ? ids.slice(0, Number(args[limitArg + 1])) : ids;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// AODP manda UTC sin la `Z`; "0001-01-01" = sin dato.
const parseDate = (d) => (d && !d.startsWith('0001') ? Date.parse(/[Zz]|[+-]\d{2}:?\d{2}$/.test(d) ? d : `${d}Z`) : NaN);
const ageMs = (d) => {
  const t = parseDate(d);
  return Number.isFinite(t) ? Date.now() - t : Infinity;
};
const bucket = (...dates) => {
  const age = Math.max(...dates.map(ageMs));
  return age <= 3 * 3600e3 ? 0 : age <= MAX_AGE_MS ? 1 : 2;
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** Copia de `robustAveragePrice` (src/utils/reliable-price.ts): mediana sin atípicos, ≥5 puntos. */
function robustAverage(points) {
  const valid = points.filter((v) => v > 0);
  if (valid.length < 5) return null;
  const med = median(valid);
  const filtered = valid.filter((v) => v >= med * 0.25 && v <= med * 4);
  return filtered.length < 3 ? med : median(filtered);
}

let requests = 0;
async function fetchJson(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    requests += 1;
    const res = await fetch(url, { headers: HEADERS }).catch(() => null);
    if (res?.ok) {
      await sleep(REQUEST_GAP_MS);
      return res.json();
    }
    // 429 = límite de AODP: esperar más antes de reintentar.
    await sleep((res?.status === 429 ? 15000 : 2000) * i);
  }
  throw new Error(`falló ${url.slice(0, 90)}`);
}

async function fetchPrices(region) {
  const rows = [];
  const loc = CITIES.map(encodeURIComponent).join(',');
  for (let i = 0; i < catalog.length; i += IDS_PER_PRICE_REQUEST) {
    const chunk = catalog.slice(i, i + IDS_PER_PRICE_REQUEST);
    rows.push(...(await fetchJson(`${HOSTS[region]}/api/v2/stats/prices/${chunk.join(',')}.json?qualities=1&locations=${loc}`)));
  }
  return rows.filter((r) => r.quality === 1);
}

async function fetchHistory(region, itemIds) {
  const out = new Map(); // `${item}|${city}` -> precios diarios dentro de la ventana
  const end = new Date();
  const start = new Date(end.getTime() - BASELINE_DAYS * 86400e3);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const loc = CITIES.map(encodeURIComponent).join(',');
  for (let i = 0; i < itemIds.length; i += IDS_PER_HISTORY_REQUEST) {
    const chunk = itemIds.slice(i, i + IDS_PER_HISTORY_REQUEST);
    const url = `${HOSTS[region]}/api/v2/stats/charts/${chunk.join(',')}.json?locations=${loc}&qualities=1&time-scale=24&date=${fmt(start)}&end_date=${fmt(end)}`;
    for (const entry of await fetchJson(url)) {
      const ts = entry.data?.timestamps ?? [];
      const prices = entry.data?.prices_avg ?? [];
      const cutoff = start.getTime();
      out.set(
        `${entry.item_id}|${entry.location}`,
        prices.filter((_, k) => (parseDate(ts[k]) || 0) >= cutoff),
      );
    }
  }
  return out;
}

function byItem(rows) {
  const map = new Map();
  for (const r of rows) (map.get(r.item_id) ?? map.set(r.item_id, []).get(r.item_id)).push(r);
  return map;
}

function transportRoutes(items) {
  const routes = [];
  for (const [id, list] of items) {
    const sells = list.filter((r) => r.sell_price_min >= MIN_PRICE && ageMs(r.sell_price_min_date) <= MAX_AGE_MS);
    const buys = list.filter((r) => r.buy_price_max >= MIN_PRICE && ageMs(r.buy_price_max_date) <= MAX_AGE_MS);
    if (!sells.length || !buys.length) continue;
    const med = median(sells.map((r) => r.sell_price_min));
    const from = sells.reduce((m, r) => (r.sell_price_min < m.sell_price_min ? r : m));
    for (const to of buys) {
      if (to.city === from.city) continue;
      // Orden de compra 3× sobre la mediana de venta: casi siempre error de captura o trol.
      if (to.buy_price_max > med * 3) continue;
      const profit = Math.floor(to.buy_price_max * (1 - RANK_TAX)) - from.sell_price_min;
      if (profit <= 0) continue;
      const roi = (profit / from.sell_price_min) * 100;
      if (roi > 300) continue;
      routes.push({
        id,
        buyCity: from.city,
        buyPrice: from.sell_price_min,
        buyAt: from.sell_price_min_date,
        sellCity: to.city,
        sellPrice: to.buy_price_max,
        sellAt: to.buy_price_max_date,
        _profit: profit,
        _roi: roi,
        _bucket: bucket(from.sell_price_min_date, to.buy_price_max_date),
      });
    }
  }
  const byProfit = [...routes].sort((a, b) => a._bucket - b._bucket || b._profit - a._profit).slice(0, TOP_TRANSPORT);
  const seen = new Set(byProfit.map((r) => `${r.id}|${r.buyCity}|${r.sellCity}`));
  const byRoi = routes
    .filter((r) => r._profit >= 1000 && !seen.has(`${r.id}|${r.buyCity}|${r.sellCity}`))
    .sort((a, b) => a._bucket - b._bucket || b._roi - a._roi)
    .slice(0, TOP_TRANSPORT_ROI);
  return { candidates: routes.length, list: [...byProfit, ...byRoi].map(({ _profit, _roi, _bucket, ...r }) => r) };
}

/** Ítem-ciudad cuyo precio fresco está bien por debajo de lo que cuesta en las demás ciudades. */
function marketCandidates(items) {
  const cands = [];
  for (const [id, list] of items) {
    const sells = list.filter((r) => r.sell_price_min >= MIN_PRICE && ageMs(r.sell_price_min_date) <= MAX_AGE_MS && r.city !== 'Black Market');
    if (sells.length < 3) continue;
    for (const r of sells) {
      const others = median(sells.filter((o) => o !== r).map((o) => o.sell_price_min));
      const ratio = r.sell_price_min / others;
      if (ratio < 0.9) cands.push({ id, row: r, ratio });
    }
  }
  return cands.sort((a, b) => a.ratio - b.ratio).slice(0, MARKET_CANDIDATES);
}

async function scanRegion(region) {
  const t0 = Date.now();
  const before = requests;
  const rows = await fetchPrices(region);
  const items = byItem(rows);
  const transport = transportRoutes(items);

  const cands = marketCandidates(items);
  const history = await fetchHistory(region, [...new Set(cands.map((c) => c.id))]);
  const market = [];
  for (const { id, row } of cands) {
    const avg = robustAverage(history.get(`${id}|${row.city}`) ?? []);
    if (avg === null) continue;
    const discount = (avg - row.sell_price_min) / avg;
    // Más de 90 % por debajo de su promedio: dato roto, no ganga.
    if (discount <= 0 || discount > 0.9) continue;
    market.push({ id, city: row.city, price: row.sell_price_min, at: row.sell_price_min_date, avg: Math.round(avg), _d: discount, _b: bucket(row.sell_price_min_date) });
  }
  market.sort((a, b) => a._b - b._b || b._d - a._d);

  const payload = {
    v: 1,
    region,
    generatedAt: new Date().toISOString(),
    baselineDays: BASELINE_DAYS,
    items: catalog.length,
    rows: rows.length,
    transport: transport.list,
    market: market.slice(0, TOP_MARKET).map(({ _d, _b, ...m }) => m),
  };
  const file = path.join(here, 'out', `${region}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  console.log(
    `${region}: ${requests - before} pedidos, ${rows.length} filas, ${transport.candidates} rutas, ` +
      `${cands.length} candidatas de mercado → ${market.length} confirmadas, ${((Date.now() - t0) / 1000).toFixed(0)} s, ` +
      `${(fs.statSync(file).size / 1024).toFixed(1)} KB`,
  );
}

fs.mkdirSync(path.join(here, 'out'), { recursive: true });
let failed = 0;
for (const region of regions) {
  try {
    await scanRegion(region);
  } catch (err) {
    // Se conserva el archivo anterior de esa región (el workflow lo trae de la rama `data`):
    // la app ve el dato viejo con su fecha y cae a su lista fija si pasa de 2 h.
    failed += 1;
    console.error(`${region}: ${err.message}`);
  }
}
if (failed === regions.length) process.exit(1);
