// Análisis puro (sin red ni disco): recibe filas de AODP y devuelve las oportunidades. Mismas reglas
// que el Radar de la app (`src/utils/radar-dashboard.ts`) para que el teléfono y el escáner coincidan.

export const MAX_AGE_MS = 12 * 3600e3; // más viejo que 12 h no es una oportunidad real
export const MIN_PRICE = 50; // AODP trae órdenes de 1-2 de plata como relleno
const RANK_TAX = 0.04; // solo para ORDENAR: la app recalcula con el impuesto del usuario
const BLACK_MARKET = 'Black Market';

/** AODP manda UTC sin la `Z`; "0001-01-01" = sin dato. */
export function parseDate(d) {
  if (typeof d !== 'string' || !d || d.startsWith('0001')) return NaN;
  return Date.parse(/[Zz]|[+-]\d{2}:?\d{2}$/.test(d) ? d : `${d}Z`);
}
export function ageMs(d, now) {
  const t = parseDate(d);
  return Number.isFinite(t) ? now - t : Infinity;
}
/** 0 = ≤3 h, 1 = ≤12 h (igual que los niveles de frescura del Radar), 2 = más viejo (solo los poco
 * comerciados de Cría/Cosecha, que aceptan hasta `SLOW_MAX_AGE_MS`). */
function bucket(now, ...dates) {
  const age = Math.max(...dates.map((d) => ageMs(d, now)));
  return age <= 3 * 3600e3 ? 0 : age <= MAX_AGE_MS ? 1 : 2;
}
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Copia exacta de `robustAveragePrice` (src/utils/reliable-price.ts). */
export function robustAverage(points) {
  const valid = points.filter((v) => v > 0);
  if (valid.length < 5) return null;
  const med = median(valid);
  const filtered = valid.filter((v) => v >= med * 0.25 && v <= med * 4);
  return filtered.length < 3 ? med : median(filtered);
}

/** Índice id → { sells: filas con venta fresca, buys: filas con orden de compra fresca }.
 * `maxAge`: 12 h para todo el Radar; Cría/Cosecha usan un índice aparte de 72 h (`SLOW_MAX_AGE_MS`). */
export function indexPrices(rows, now, maxAge = MAX_AGE_MS) {
  const index = new Map();
  for (const r of rows) {
    if (!r || r.quality !== 1 || typeof r.item_id !== 'string') continue;
    let entry = index.get(r.item_id);
    if (!entry) index.set(r.item_id, (entry = { sells: [], buys: [] }));
    if (r.sell_price_min >= MIN_PRICE && r.city !== BLACK_MARKET && ageMs(r.sell_price_min_date, now) <= maxAge) entry.sells.push(r);
    if (r.buy_price_max >= MIN_PRICE && ageMs(r.buy_price_max_date, now) <= maxAge) entry.buys.push(r);
  }
  return index;
}

// ---- Cría y Cosecha (BR.6 #4, plan docs/plans/cria-cosecha-precios-2026-10-01.md en la app) ----
// Animales, crías y semillas casi no se comercian: AODP rara vez tiene un precio de ≤12 h. Estas
// tarjetas aceptan hasta 72 h (la app muestra "hace X h"), descartan los precios atípicos contra el
// promedio de 30 días de esa ciudad y calculan también la venta con orden de venta, que es como vende
// quien produce (la venta inmediata regala la diferencia entre órdenes).
export const SLOW_MAX_AGE_MS = 72 * 3600e3;
/** Comisión por publicar una orden (2,5 %), además del impuesto de venta. */
export const SETUP_FEE = 0.025;
/** Fuera de [promedio ÷ 3, promedio × 3] el precio es atípico (el mamut T8 −89 % era esto). */
const ATYPICAL_FACTOR = 3;
/** Venta y compra con más del 40 % de diferencia (o cruzadas): libro roto, no puede liderar. */
const MAX_SPREAD = 0.4;

/** Quita las filas atípicas contra el promedio de 30 días de SU ciudad (sin promedio, se quedan). */
export function cleanEntry(entry, id, avg30) {
  if (!entry) return null;
  const ok = (price, city) => {
    const avg = avg30 ? avg30(id, city) : null;
    return !(avg > 0) || (price >= avg / ATYPICAL_FACTOR && price <= avg * ATYPICAL_FACTOR);
  };
  return {
    sells: entry.sells.filter((r) => ok(r.sell_price_min, r.city)),
    buys: entry.buys.filter((r) => ok(r.buy_price_max, r.city)),
  };
}

/** Lado de venta de un producto: orden de compra (inmediata) y la venta más barata publicada (con
 * orden). `weak` = libro roto o una sola ciudad con venta: se publica pero no lidera. */
function saleSides(entry) {
  const buy = bestBuy(entry);
  const order = cheapestSell(entry);
  const cities = entry ? entry.sells.length : 0;
  // Venta más barata por debajo de la mejor compra es normal ENTRE ciudades (de eso vive Transporte):
  // solo cuenta la diferencia cuando la venta está por encima.
  const wide = buy && order && order.sell_price_min > buy.buy_price_max && (order.sell_price_min - buy.buy_price_max) / order.sell_price_min > MAX_SPREAD;
  return { buy, order, cities, weak: Boolean(wide || cities < 2) };
}
const orderRef = (r, cities) => ({ price: r.sell_price_min, city: r.city, at: r.sell_price_min_date, cities });

/** Venta más barata (dónde comprar) y orden de compra más alta (dónde vender), con guarda anti-trol. */
function cheapestSell(entry) {
  if (!entry?.sells.length) return null;
  return entry.sells.reduce((m, r) => (r.sell_price_min < m.sell_price_min ? r : m));
}
function bestBuy(entry) {
  if (!entry?.buys.length) return null;
  // Orden de compra 3× sobre la mediana de venta: casi siempre error de captura o trol.
  const cap = entry.sells.length ? median(entry.sells.map((r) => r.sell_price_min)) * 3 : Infinity;
  const ok = entry.buys.filter((r) => r.buy_price_max <= cap);
  return ok.length ? ok.reduce((m, r) => (r.buy_price_max > m.buy_price_max ? r : m)) : null;
}
const side = (r, kind) =>
  kind === 'sell'
    ? { price: r.sell_price_min, city: r.city, at: r.sell_price_min_date }
    : { price: r.buy_price_max, city: r.city, at: r.buy_price_max_date };

export function transportRoutes(index, now, { top = 150, topRoi = 50 } = {}) {
  const routes = [];
  for (const [id, entry] of index) {
    const from = cheapestSell(entry);
    if (!from) continue;
    const cap = median(entry.sells.map((r) => r.sell_price_min)) * 3;
    for (const to of entry.buys) {
      if (to.city === from.city || to.buy_price_max > cap) continue;
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
        _p: profit,
        _r: roi,
        _b: bucket(now, from.sell_price_min_date, to.buy_price_max_date),
      });
    }
  }
  const byProfit = [...routes].sort((a, b) => a._b - b._b || b._p - a._p).slice(0, top);
  const seen = new Set(byProfit);
  const byRoi = routes
    .filter((r) => r._p >= 1000 && !seen.has(r))
    .sort((a, b) => a._b - b._b || b._r - a._r)
    .slice(0, topRoi);
  return { candidates: routes.length, list: [...byProfit, ...byRoi].map(({ _p, _r, _b, ...r }) => r) };
}

/**
 * Ciudad donde un ítem está más barato que SU propio promedio de 30 días en esa ciudad.
 * `avgOf(id, city)` devuelve el promedio robusto guardado o null. Todas las ciudades de todos los
 * ítems (no candidatos): el promedio de cada una se refresca en rotación.
 */
export function marketDeals(index, avgOf, now, { top = 150 } = {}) {
  const deals = [];
  for (const [id, entry] of index) {
    for (const r of entry.sells) {
      const avg = avgOf(id, r.city);
      if (!avg) continue;
      const discount = (avg - r.sell_price_min) / avg;
      // Más de 90 % por debajo del promedio: dato roto, no ganga.
      if (discount <= 0.03 || discount > 0.9) continue;
      deals.push({ id, city: r.city, price: r.sell_price_min, at: r.sell_price_min_date, avg: Math.round(avg), _d: discount, _b: bucket(now, r.sell_price_min_date) });
    }
  }
  deals.sort((a, b) => a._b - b._b || b._d - a._d);
  return { candidates: deals.length, list: deals.slice(0, top).map(({ _d, _b, ...d }) => d) };
}

const enchantSuffix = (e, levelInfix) => (e > 0 ? (levelInfix ? `_LEVEL${e}@${e}` : `@${e}`) : '');

/** Crafteo de TODAS las recetas en T4-T8 y encantamientos 0-4 (recursos refinados del mismo encantamiento). */
export function craftDeals(index, recipes, returnRate, now, { top = 100 } = {}) {
  const deals = [];
  for (const recipe of recipes) {
    for (let tier = 4; tier <= 8; tier++) {
      for (let e = 0; e <= 4; e++) {
        const id = `T${tier}_${recipe.base}${enchantSuffix(e, false)}`;
        const sell = bestBuy(index.get(id));
        if (!sell) continue;
        const resources = [];
        let ok = true;
        let materials = 0;
        for (const [code, q] of Object.entries(recipe.resources)) {
          const rid = `T${tier}_${code}${enchantSuffix(e, true)}`;
          const buy = cheapestSell(index.get(rid));
          if (!buy) {
            ok = false;
            break;
          }
          materials += q * buy.sell_price_min;
          resources.push({ id: rid, q, ...side(buy, 'sell') });
        }
        if (!ok) continue;
        let artifact = null;
        if (recipe.artifact) {
          const aid = `T${tier}_ARTEFACT_${recipe.artifact}`;
          const buy = cheapestSell(index.get(aid));
          if (!buy) continue;
          artifact = { id: aid, q: 1, ...side(buy, 'sell') };
        }
        // La devolución aplica a los materiales, no al artefacto.
        const cost = materials * (1 - returnRate) + (artifact?.price ?? 0);
        const profit = sell.buy_price_max * (1 - RANK_TAX) - cost;
        if (profit <= 0) continue;
        const roi = (profit / cost) * 100;
        if (roi > 300) continue;
        const dates = [sell.buy_price_max_date, ...resources.map((r) => r.at), ...(artifact ? [artifact.at] : [])];
        deals.push({ id, resources, artifact, sellCity: sell.city, sellPrice: sell.buy_price_max, sellAt: sell.buy_price_max_date, _p: profit, _b: bucket(now, ...dates) });
      }
    }
  }
  deals.sort((a, b) => a._b - b._b || b._p - a._p);
  return { candidates: deals.length, list: deals.slice(0, top).map(({ _p, _b, ...d }) => d) };
}

/** Refinado de los 5 recursos en T4-T8 (la piedra solo sin encantar), sin foco. */
export function refineDeals(index, refining, now, { top = 60 } = {}) {
  const deals = [];
  for (const [name, r] of Object.entries(refining.resources)) {
    for (let tier = 4; tier <= 8; tier++) {
      const ratio = refining.tierRatios[String(tier)];
      if (!ratio) continue;
      for (let e = 0; e <= (r.raw === 'ROCK' ? 0 : 4); e++) {
        const refinedId = `T${tier}_${r.refined}${enchantSuffix(e, true)}`;
        const rawId = `T${tier}_${r.raw}${enchantSuffix(e, true)}`;
        // El sub-material es el refinado del tier anterior con el mismo encantamiento; T3 no se encanta.
        const subId = ratio.sub > 0 ? `T${tier - 1}_${r.refined}${tier - 1 >= 4 ? enchantSuffix(e, true) : ''}` : null;
        const sell = bestBuy(index.get(refinedId));
        const raw = cheapestSell(index.get(rawId));
        const sub = subId ? cheapestSell(index.get(subId)) : null;
        if (!sell || !raw || (subId && !sub)) continue;
        const rawCost = ratio.raw * raw.sell_price_min;
        // Misma fórmula que el Radar: la devolución sale del costo del crudo.
        const cost = rawCost + (sub ? ratio.sub * sub.sell_price_min : 0) - rawCost * refining.returnRate;
        const revenue = ratio.output * sell.buy_price_max;
        const profit = revenue * (1 - RANK_TAX) - cost;
        if (cost <= 0 || profit <= 0) continue;
        if ((profit / cost) * 100 > 300) continue;
        const dates = [sell.buy_price_max_date, raw.sell_price_min_date, ...(sub ? [sub.sell_price_min_date] : [])];
        deals.push({
          id: refinedId,
          resource: name,
          tier,
          enchant: e,
          raw: { id: rawId, q: ratio.raw, ...side(raw, 'sell') },
          sub: sub ? { id: subId, q: ratio.sub, ...side(sub, 'sell') } : null,
          output: ratio.output,
          sellCity: sell.city,
          sellPrice: sell.buy_price_max,
          sellAt: sell.buy_price_max_date,
          bonusCity: r.bonusCity,
          _p: profit,
          _b: bucket(now, ...dates),
        });
      }
    }
  }
  deals.sort((a, b) => a._b - b._b || b._p - a._p);
  return { candidates: deals.length, list: deals.slice(0, top).map(({ _p, _b, ...d }) => d) };
}

/** Ganancia con venta inmediata y con orden de venta (null si falta ese lado). */
function saleProfits(sides, units, cost) {
  const instant = sides.buy ? units * sides.buy.buy_price_max * (1 - RANK_TAX) - cost : null;
  const order = sides.order ? units * sides.order.sell_price_min * (1 - SETUP_FEE - RANK_TAX) - cost : null;
  return { instant, order, best: Math.max(instant ?? -Infinity, order ?? -Infinity) };
}
/** Campos de venta compatibles con la app publicada (`sellPrice` = orden de compra, 0 si no hay). */
function legacySell(sides) {
  return sides.buy
    ? { sellCity: sides.buy.city, sellPrice: sides.buy.buy_price_max, sellAt: sides.buy.buy_price_max_date }
    : { sellCity: sides.order.city, sellPrice: 0, sellAt: sides.order.sell_price_min_date };
}
const saleDates = (sides) => [sides.buy?.buy_price_max_date, sides.order?.sell_price_min_date].filter(Boolean);
const byRank = (a, b) => a._w - b._w || a._b - b._b || b._p - a._p;

/**
 * Cosecha: los 15 cultivos, 9 cultivos por semilla (Premium). La semilla vuelve con la chance OFICIAL
 * sin foco (`seedReturn`, del volcado: 0 la zanahoria T1, 0,8 el repollo T5, 0,93 la calabaza T8), así
 * que cada siembra cuesta precio × (1 − devolución), no la semilla entera. `index` es el de 72 h.
 */
export function farmDeals(index, farm, now, { top = 15, avg30 = null } = {}) {
  const deals = [];
  for (const c of farm.crops) {
    const seed = cheapestSell(cleanEntry(index.get(c.seed), c.seed, avg30));
    const sides = saleSides(cleanEntry(index.get(c.crop), c.crop, avg30));
    if (!seed || (!sides.buy && !sides.order)) continue;
    const seedReturn = Math.min(1, Math.max(0, Number(c.seedReturn) || 0));
    const cost = seed.sell_price_min * (1 - seedReturn);
    const p = saleProfits(sides, farm.yieldPerSeed, cost);
    if (!(p.best > 0)) continue;
    deals.push({
      id: c.crop,
      seed: { id: c.seed, q: 1, ...side(seed, 'sell') },
      yield: farm.yieldPerSeed,
      seedReturn,
      ...legacySell(sides),
      order: sides.order ? orderRef(sides.order, sides.cities) : null,
      weak: sides.weak,
      _p: p.best,
      _w: sides.weak ? 1 : 0,
      _b: bucket(now, seed.sell_price_min_date, ...saleDates(sides)),
    });
  }
  deals.sort(byRank);
  return { candidates: deals.length, list: deals.slice(0, top).map(({ _p, _b, _w, ...d }) => d) };
}

/**
 * Cría: todos los animales y tiers, con los datos OFICIALES por especie que exporta la app
 * (`catalog.farm.animals[]`: `feedId`, `feedUnits`, `offspring`, `meatQty`) — misma fórmula que
 * `breedEconomics` de la app con foco apagado: venta (carne × lo que da el carnicero, o el adulto) −
 * impuesto + crías devueltas × precio de la cría − (cría + alimento). Antes se usaba 1 carne, 18 de
 * repollo para todos y sin cría devuelta: casi nada daba margen y la tarjeta Cría quedaba vacía.
 * Catálogos viejos sin esos campos caen al supuesto anterior. `sellPrice` sigue siendo el de UNA
 * unidad (la app multiplica por su `meatQty`).
 */
export function breedDeals(index, farm, now, { top = 30, avg30 = null } = {}) {
  const feedCache = new Map();
  const feedOf = (id) => {
    if (!feedCache.has(id)) feedCache.set(id, cheapestSell(cleanEntry(index.get(id), id, avg30)));
    return feedCache.get(id);
  };
  const deals = [];
  for (const a of farm.animals) {
    const feedId = a.feedId ?? farm.feedId;
    const feedUnits = a.feedUnits ?? farm.feedUnits;
    const meatQty = a.meatQty ?? 1;
    const offspring = a.offspring ?? 0;
    const feed = feedOf(feedId);
    const babyEntry = cleanEntry(index.get(a.baby), a.baby, avg30);
    const baby = cheapestSell(babyEntry);
    const sides = saleSides(cleanEntry(index.get(a.sell), a.sell, avg30));
    if (!feed || !baby || (!sides.buy && !sides.order)) continue;
    // Las crías devueltas reponen la próxima compra (ciclo cerrado): valen lo que te ahorras, el
    // precio al que la comprarías. Equivale a pagar la cría × (1 − devueltas). Los precios atípicos
    // ya salieron con el promedio de 30 días; con una sola ciudad la oportunidad no lidera.
    const cost = baby.sell_price_min + feedUnits * feed.sell_price_min;
    const p = saleProfits(sides, meatQty, cost - offspring * baby.sell_price_min);
    if (!(p.best > 0) || (p.best / cost) * 100 > 300) continue;
    deals.push({
      id: a.sell,
      animal: a.code,
      tier: a.tier,
      baby: { id: a.baby, q: 1, ...side(baby, 'sell'), cities: babyEntry.sells.length },
      feed: { id: feedId, q: feedUnits, ...side(feed, 'sell') },
      ...legacySell(sides),
      order: sides.order ? orderRef(sides.order, sides.cities) : null,
      weak: sides.weak || babyEntry.sells.length < 2,
      _p: p.best,
      _w: sides.weak || babyEntry.sells.length < 2 ? 1 : 0,
      _b: bucket(now, baby.sell_price_min_date, feed.sell_price_min_date, ...saleDates(sides)),
    });
  }
  deals.sort(byRank);
  return { candidates: deals.length, list: deals.slice(0, top).map(({ _p, _b, _w, ...d }) => d) };
}

/**
 * Monturas y consumibles (BQ.10): hacer una montura con el adulto + materiales, o cocinar comida y
 * pociones. Mismo supuesto conservador que el Crafteo del Radar: sin foco ni ciudad con bono; la
 * devolución (`returnRate`) aplica a los ingredientes de cocina y alquimia, nunca a la montura ni al
 * carnear (el animal no se devuelve). `kind: 'butcher'`: comprar el adulto y venderlo en carne. Venta = `n` unidades × la mejor orden de compra.
 */
export function makeDeals(index, make, returnRate, now, { top = 15, slowIndex = null, avg30 = null } = {}) {
  const deals = [];
  for (const m of make ?? []) {
    // Catálogo roto (n o res faltantes/malformados): se salta, nunca publica NaN ni tumba la región.
    if (!m || typeof m.id !== 'string' || !Number.isFinite(m.n) || m.n <= 0 || !Array.isArray(m.res) || !m.res.length) continue;
    // Montura y carnear llevan un animal adulto (poco comerciado): índice de 72 h, sin atípicos y con
    // la venta con orden además de la inmediata, como Cría. Pociones y comida siguen igual (12 h).
    const slow = slowIndex && (m.kind === 'mount' || m.kind === 'butcher');
    const entryOf = (id) => (slow ? cleanEntry(slowIndex.get(id), id, avg30) : index.get(id));
    const sides = slow ? saleSides(entryOf(m.id)) : { buy: bestBuy(index.get(m.id)), order: null, cities: 0, weak: false };
    if (!sides.buy && !sides.order) continue;
    const resources = [];
    let materials = 0;
    let ok = true;
    for (const pair of m.res) {
      const [rid, q] = Array.isArray(pair) ? pair : [];
      const buy = typeof rid === 'string' && Number.isFinite(q) && q > 0 ? cheapestSell(entryOf(rid)) : null;
      if (!buy) {
        ok = false;
        break;
      }
      materials += q * buy.sell_price_min;
      resources.push({ id: rid, q, ...side(buy, 'sell') });
    }
    if (!ok) continue;
    const cost = materials * (1 - (m.kind === 'mount' || m.kind === 'butcher' ? 0 : returnRate));
    const p = saleProfits(sides, m.n, cost);
    if (cost <= 0 || !(p.best > 0) || (p.best / cost) * 100 > 300) continue;
    deals.push({
      id: m.id,
      kind: m.kind,
      n: m.n,
      resources,
      ...legacySell(sides),
      ...(slow ? { order: sides.order ? orderRef(sides.order, sides.cities) : null, weak: sides.weak } : {}),
      _p: p.best,
      _w: sides.weak ? 1 : 0,
      _b: bucket(now, ...saleDates(sides), ...resources.map((r) => r.at)),
    });
  }
  deals.sort(byRank);
  // Tope POR TIPO (montura, poción, comida, carne): cada tarjeta del Radar toma lo suyo.
  const perKind = new Map();
  const list = deals.filter((d) => {
    const n = perKind.get(d.kind) ?? 0;
    perKind.set(d.kind, n + 1);
    return n < top;
  });
  return { candidates: deals.length, list: list.map(({ _p, _b, _w, ...d }) => d) };
}

/**
 * Estadísticas de una serie diaria (puntos {t, price, count}): promedios robustos de 7/30/90/180 días,
 * tendencia (mediana de los últimos 14 días contra los 14 anteriores, en %), unidades vendidas en 7
 * días y una proyección a 7 días (recta de mínimos cuadrados sobre los últimos 30 días). La proyección
 * solo se da si la recta explica la serie (R² ≥ 0,3) y queda acotada a ±30 % del precio actual: es una
 * estimación, no una promesa; con picos sueltos no se inventa nada.
 */
export function seriesStats(points, now) {
  const since = (days) => points.filter((p) => p.t >= now - days * 86400e3);
  const avg = (days) => Math.round(robustAverage(since(days).map((p) => p.price)) ?? 0);
  const last14 = since(14).map((p) => p.price);
  const prev14 = points.filter((p) => p.t < now - 14 * 86400e3 && p.t >= now - 28 * 86400e3).map((p) => p.price);
  let trendPct = 0;
  if (last14.length >= 5 && prev14.length >= 5) {
    const a = median(last14);
    const b = median(prev14);
    if (b > 0) trendPct = Math.round(((a - b) / b) * 1000) / 10;
  }
  const volume7 = since(7).reduce((sum, p) => sum + (p.count || 0), 0);
  let projection7 = 0;
  const last30 = since(30);
  if (last30.length >= 10) {
    const xs = last30.map((p) => (p.t - now) / 86400e3);
    const ys = last30.map((p) => p.price);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let den = 0;
    let tot = 0;
    xs.forEach((x, i) => {
      num += (x - mx) * (ys[i] - my);
      den += (x - mx) ** 2;
      tot += (ys[i] - my) ** 2;
    });
    const slope = den > 0 ? num / den : 0;
    const r2 = den > 0 && tot > 0 ? (num * num) / (den * tot) : 0;
    if (r2 >= 0.3) {
      const current = median(since(3).map((p) => p.price).concat(ys.slice(-1)));
      const projected = my + slope * (7 - mx);
      projection7 = Math.round(Math.min(current * 1.3, Math.max(current * 0.7, projected)));
    }
  }
  return { avg7: avg(7), avg30: avg(30), avg90: avg(90), avg180: avg(180), trendPct, volume7, projection7 };
}

/** Lo que más sube y más baja (con volumen mínimo, para que no sean ítems que casi nadie compra). */
export function trendMovers(index, statsOf, cities, { top = 50, minVolume = 50 } = {}) {
  const rows = [];
  for (const [id] of index) {
    for (const city of cities) {
      if (city === 'Black Market') continue;
      const st = statsOf(id, city);
      if (!st || !st.trendPct || st.volume7 < minVolume || Math.abs(st.trendPct) > 400) continue;
      rows.push({ id, city, trendPct: st.trendPct, avg30: st.avg30, volume7: st.volume7, projection7: st.projection7 });
    }
  }
  const rising = rows.filter((r) => r.trendPct > 0).sort((a, b) => b.trendPct - a.trendPct).slice(0, top);
  const falling = rows.filter((r) => r.trendPct < 0).sort((a, b) => a.trendPct - b.trendPct).slice(0, top);
  return { candidates: rows.length, rising, falling };
}

/** Ítems que más plata movieron en 7 días (unidades × precio, sumando ciudades), dónde se venden más
 * y la ciudad que mejor paga hoy. Por plata y no por unidades: si no, siempre ganan las runas. */
export function mostTraded(index, statsOf, cities, { top = 100 } = {}) {
  const rows = [];
  for (const [id, entry] of index) {
    let volume = 0;
    let silver = 0;
    let topCity = null;
    let topVolume = 0;
    for (const city of cities) {
      const st = statsOf(id, city);
      if (!st) continue;
      volume += st.volume7;
      silver += st.volume7 * st.avg30;
      if (st.volume7 > topVolume) {
        topVolume = st.volume7;
        topCity = city;
      }
    }
    if (volume <= 0) continue;
    const best = bestBuy(entry);
    const cheapest = cheapestSell(entry);
    rows.push({
      id,
      volume7: volume,
      silver7: Math.round(silver),
      topCity,
      bestSell: best ? side(best, 'buy') : null,
      cheapestBuy: cheapest ? side(cheapest, 'sell') : null,
    });
  }
  rows.sort((a, b) => b.silver7 - a.silver7);
  return { candidates: rows.length, list: rows.slice(0, top) };
}

/** Valor de mercado por ítem: mediana entre ciudades (sin el Mercado Negro) del promedio de 30 días
 * o, si no hay, de la venta fresca más barata. Enteros; sin valor no entra. */
export function itemValues(ids, avg30Of, index, cities) {
  const out = {};
  for (const id of ids) {
    const avgs = cities.filter((c) => c !== BLACK_MARKET).map((c) => avg30Of(id, c)).filter((v) => v > 0);
    let v = avgs.length ? median(avgs) : null;
    if (!v) {
      const sells = index.get(id)?.sells ?? [];
      if (sells.length) v = median(sells.map((r) => r.sell_price_min));
    }
    if (v > 0) out[id] = Math.round(v);
  }
  return out;
}

// ---- Mercado Negro (parte 73 de la app, pedido del dueño) ----
// "Cuando entre a Mercado Negro, que salgan las ofertas que hay ahí: te compra enseguida y casi siempre
// paga mejor que cualquier ciudad; saber qué tan bueno está su precio." Cada orden de compra fresca del
// Mercado Negro (calidad 1, ≤12 h) con lo necesario para compararla: el promedio de 30 días de lo que
// pagó, la referencia de las ciudades (mediana de sus promedios de 30 días), la mejor venta inmediata en
// una ciudad real y la venta más barata publicada (para revender). Del lado de las ciudades vale hasta
// 72 h (`slowIndex`): el equipo casi nunca tiene orden de compra de ≤12 h en las ciudades y sin eso la
// mayoría de las ofertas quedaba sin con qué comparar (la app muestra la edad de cada precio).

/** Ciudades reales (sin el Mercado Negro), en el orden del archivo publicado. */
export const BM_CITIES = ['Caerleon', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien'];

/**
 * Filas compactas (el archivo de Europa tiene ~5.000 ofertas): `[id, precio, edadMin, promedioMN30,
 * promedioCiudades30, ventaYa, ciudadVentaYa, edadVentaYa, compra, ciudadCompra, edadCompra]`, con 0
 * (precio/promedio) o -1 (ciudad/edad) cuando falta. Edades en minutos respecto de `now`. Ordenadas por
 * precio de mayor a menor.
 */
export function blackMarketOffers(index, now, { slowIndex = null, avg30 = null, top = 6000 } = {}) {
  const cityPos = new Map(BM_CITIES.map((c, i) => [c, i]));
  const ageMin = (d) => {
    const a = ageMs(d, now);
    return Number.isFinite(a) ? Math.max(0, Math.round(a / 60000)) : -1;
  };
  const rows = [];
  let candidates = 0;
  for (const [id, entry] of index) {
    const bm = entry.buys.find((r) => r.city === BLACK_MARKET);
    if (!bm) continue;
    candidates += 1;
    const price = bm.buy_price_max;
    const city = cleanEntry(slowIndex?.get(id) ?? entry, id, avg30);
    // Anti-trol / error de captura contra PROMEDIOS (no contra las ventas del momento: una venta de
    // relleno de 100 de plata bajaba la mediana y tiraba una oferta real): fuera de [÷3, ×3] de lo que el
    // propio Mercado Negro pagó en 30 días, o 3× sobre el promedio de las ciudades. Sin referencia, queda.
    const bmAvg = avg30 ? avg30(id, BLACK_MARKET) : null;
    if (bmAvg > 0 && (price > bmAvg * ATYPICAL_FACTOR || price < bmAvg / ATYPICAL_FACTOR)) continue;
    const cityAvgs = avg30 ? BM_CITIES.map((c) => avg30(id, c)).filter((v) => v > 0) : [];
    const cityAvg = cityAvgs.length ? Math.round(median(cityAvgs)) : 0;
    if (cityAvg > 0 && price > cityAvg * ATYPICAL_FACTOR) continue;
    // Una orden de compra de una ciudad por debajo del 10 % de lo que paga el Mercado Negro es una
    // oferta de relleno (T8.4 a 1.115 de plata contra 55 M): no es una alternativa real de venta.
    const realBuys = city.buys.filter((r) => cityPos.has(r.city) && r.buy_price_max >= price * 0.1);
    const instant = realBuys.length ? realBuys.reduce((m, r) => (r.buy_price_max > m.buy_price_max ? r : m)) : null;
    // Una venta tan barata que revenderla daría más de 300 % es un dato roto (mismo tope que Transporte).
    const realSells = city.sells.filter((r) => cityPos.has(r.city) && r.sell_price_min * 4 >= price);
    const cheapest = realSells.length ? realSells.reduce((m, r) => (r.sell_price_min < m.sell_price_min ? r : m)) : null;
    rows.push([
      id,
      price,
      ageMin(bm.buy_price_max_date),
      bmAvg > 0 ? Math.round(bmAvg) : 0,
      cityAvg,
      instant ? instant.buy_price_max : 0,
      instant ? cityPos.get(instant.city) : -1,
      instant ? ageMin(instant.buy_price_max_date) : -1,
      cheapest ? cheapest.sell_price_min : 0,
      cheapest ? cityPos.get(cheapest.city) : -1,
      cheapest ? ageMin(cheapest.sell_price_min_date) : -1,
    ]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  return { candidates, list: rows.slice(0, top) };
}
