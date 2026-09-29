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
/** 0 = ≤3 h, 1 = ≤12 h (igual que los niveles de frescura del Radar). */
function bucket(now, ...dates) {
  const age = Math.max(...dates.map((d) => ageMs(d, now)));
  return age <= 3 * 3600e3 ? 0 : 1;
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

/** Índice id → { sells: filas con venta fresca, buys: filas con orden de compra fresca }. */
export function indexPrices(rows, now) {
  const index = new Map();
  for (const r of rows) {
    if (!r || r.quality !== 1 || typeof r.item_id !== 'string') continue;
    let entry = index.get(r.item_id);
    if (!entry) index.set(r.item_id, (entry = { sells: [], buys: [] }));
    if (r.sell_price_min >= MIN_PRICE && r.city !== BLACK_MARKET && ageMs(r.sell_price_min_date, now) <= MAX_AGE_MS) entry.sells.push(r);
    if (r.buy_price_max >= MIN_PRICE && ageMs(r.buy_price_max_date, now) <= MAX_AGE_MS) entry.buys.push(r);
  }
  return index;
}

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

/** Cosecha: los 15 cultivos. Mismo cálculo que el Radar: 9 cultivos por semilla (Premium). */
export function farmDeals(index, farm, now, { top = 15 } = {}) {
  const deals = [];
  for (const c of farm.crops) {
    const seed = cheapestSell(index.get(c.seed));
    const sell = bestBuy(index.get(c.crop));
    if (!seed || !sell) continue;
    const profit = farm.yieldPerSeed * sell.buy_price_max * (1 - RANK_TAX) - seed.sell_price_min;
    if (profit <= 0) continue;
    deals.push({
      id: c.crop,
      seed: { id: c.seed, q: 1, ...side(seed, 'sell') },
      yield: farm.yieldPerSeed,
      sellCity: sell.city,
      sellPrice: sell.buy_price_max,
      sellAt: sell.buy_price_max_date,
      _p: profit,
      _b: bucket(now, seed.sell_price_min_date, sell.buy_price_max_date),
    });
  }
  deals.sort((a, b) => a._b - b._b || b._p - a._p);
  return { candidates: deals.length, list: deals.slice(0, top).map(({ _p, _b, ...d }) => d) };
}

/** Cría: todos los animales y tiers. La granja clásica se vende como carne; monturas y salvajes, crecidos. */
export function breedDeals(index, farm, now, { top = 30 } = {}) {
  const feed = cheapestSell(index.get(farm.feedId));
  if (!feed) return { candidates: 0, list: [] };
  const deals = [];
  for (const a of farm.animals) {
    const baby = cheapestSell(index.get(a.baby));
    const sell = bestBuy(index.get(a.sell));
    if (!baby || !sell) continue;
    const cost = baby.sell_price_min + farm.feedUnits * feed.sell_price_min;
    const profit = sell.buy_price_max * (1 - RANK_TAX) - cost;
    if (profit <= 0 || (profit / cost) * 100 > 300) continue;
    deals.push({
      id: a.sell,
      animal: a.code,
      tier: a.tier,
      baby: { id: a.baby, q: 1, ...side(baby, 'sell') },
      feed: { id: farm.feedId, q: farm.feedUnits, ...side(feed, 'sell') },
      sellCity: sell.city,
      sellPrice: sell.buy_price_max,
      sellAt: sell.buy_price_max_date,
      _p: profit,
      _b: bucket(now, baby.sell_price_min_date, feed.sell_price_min_date, sell.buy_price_max_date),
    });
  }
  deals.sort((a, b) => a._b - b._b || b._p - a._p);
  return { candidates: deals.length, list: deals.slice(0, top).map(({ _p, _b, ...d }) => d) };
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
