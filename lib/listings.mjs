// Archivo diario de precios PUBLICADOS (rama `listings`).
//
// Por qué existe: el historial de AODP son VENTAS que suben los jugadores al abrir el historial de un
// ítem en una ciudad. Una ciudad poco vista se queda meses sin puntos aunque tenga precio publicado
// todos los días (Túnica de clérigo T5 en Caerleon, Américas: última venta registrada el 17/06/2026 y
// precio publicado visto el 29/09). Cada vuelta completa ya baja el precio publicado de todo el
// mercado; acá se guarda, por día, el más barato a la venta y la mejor orden de compra (la del Mercado
// Negro, que solo compra, es la que importa para vender ahí).
//
// Formato de `listings/<region>/<id>.json` (uno por ítem, lo baja la app al abrir ese ítem):
//   { v: 1, id, region, c: { "<índice de ciudad>": [[día, venta mín., compra máx.], ...] } }
// `día` = días desde 1970-01-01 (UTC); 0 = sin dato ese día en ese lado. Se guardan KEEP_DAYS días.
import fs from 'node:fs';
import path from 'node:path';

import { parseDate } from './analyze.mjs';
import { readJson, writeJson } from './store.mjs';

export const KEEP_DAYS = 370;

const DAY_MS = 86400e3;
export const dayNumber = (ms) => Math.floor(ms / DAY_MS);
export const dayString = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/**
 * Suma las filas de precios de esta vuelta al día en curso. Solo cuentan observaciones de HOY (UTC):
 * un precio de ayer que nadie volvió a ver no se sabe si sigue en pie. Venta = el más barato del
 * día; compra = la orden más alta del día.
 *
 * `buffer` = { day, p: { "<id>|<ciudad#>": [venta, compra] } } o null. Devuelve
 * `{ buffer, closed }`: si el día cambió, `closed` es el buffer del día anterior (listo para escribir).
 */
export function recordListings(buffer, rows, cityIndex, now) {
  const today = dayNumber(now);
  let closed = null;
  let current = buffer;
  if (!current || current.day !== today) {
    if (current && current.day < today && Object.keys(current.p ?? {}).length) closed = current;
    current = { day: today, p: {} };
  }
  for (const r of rows) {
    if (r?.quality !== 1 || typeof r.item_id !== 'string') continue;
    const ci = cityIndex.get(r.city);
    if (ci === undefined) continue;
    const sellAt = parseDate(r.sell_price_min_date);
    const buyAt = parseDate(r.buy_price_max_date);
    const sell = r.sell_price_min > 0 && Number.isFinite(sellAt) && dayNumber(sellAt) === today ? Math.round(r.sell_price_min) : 0;
    const buy = r.buy_price_max > 0 && Number.isFinite(buyAt) && dayNumber(buyAt) === today ? Math.round(r.buy_price_max) : 0;
    if (!sell && !buy) continue;
    const key = `${r.item_id}|${ci}`;
    const prev = current.p[key];
    if (!prev) current.p[key] = [sell, buy];
    else {
      if (sell && (!prev[0] || sell < prev[0])) prev[0] = sell;
      if (buy && buy > prev[1]) prev[1] = buy;
    }
  }
  return { buffer: current, closed };
}

/** Agrega un día a la serie de un ítem (idempotente: si el día ya está, lo reemplaza) y recorta a
 * KEEP_DAYS. Pura: devuelve un objeto nuevo. */
export function mergeDay(file, id, region, day, perCity) {
  const base = file?.v === 1 && file.c && typeof file.c === 'object' ? file.c : {};
  const minDay = day - KEEP_DAYS + 1;
  const c = {};
  const cities = new Set([...Object.keys(base), ...Object.keys(perCity)]);
  for (const ci of cities) {
    const add = perCity[ci];
    // Solo se reemplaza el día en las ciudades que traen dato nuevo; las demás conservan el suyo.
    const series = (Array.isArray(base[ci]) ? base[ci] : []).filter(
      (pt) => Array.isArray(pt) && pt[0] >= minDay && !(add && pt[0] === day),
    );
    if (add) series.push([day, add[0], add[1]]);
    series.sort((a, b) => a[0] - b[0]);
    if (series.length) c[ci] = series;
  }
  return { v: 1, id, region, c };
}

/** Escribe un día cerrado en los archivos por ítem de `dir` (= listings/<region>). Devuelve cuántos
 * archivos tocó. Un archivo dañado se reconstruye desde este día (lectura tolerante). */
export function writeClosedDay(dir, region, closed, log = () => {}) {
  const byId = new Map();
  for (const [key, pair] of Object.entries(closed.p)) {
    const bar = key.lastIndexOf('|');
    const id = key.slice(0, bar);
    const ci = key.slice(bar + 1);
    if (!byId.has(id)) byId.set(id, {});
    byId.get(id)[ci] = pair;
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, perCity] of byId) {
    const file = path.join(dir, `${fileName(id)}.json`);
    writeJson(file, mergeDay(readJson(file, null, log), id, region, closed.day, perCity));
  }
  return byId.size;
}

/** Nombre de archivo de un id. Los ids de AODP son [A-Z0-9_@]; `@` (encantamiento) es válido en
 * archivos y en URLs de raw.githubusercontent (la app lo pide codificado como %40). */
export function fileName(id) {
  return id.replace(/[^A-Za-z0-9_@-]/g, '_');
}
