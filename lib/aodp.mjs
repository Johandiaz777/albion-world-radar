// Cliente de AODP (Albion Online Data Project) con los mismos cuidados que el scraper de kills:
// pedidos agrupados por LARGO de URL (no por cantidad fija de ids), ritmo por host, reintentos con
// espera creciente y pausa larga ante 429 (límite de AODP: 180/min y 300 cada 5 min).

export const HOSTS = {
  americas: 'https://west.albion-online-data.com',
  europe: 'https://europe.albion-online-data.com',
  asia: 'https://east.albion-online-data.com',
};

export const CITIES = ['Caerleon', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien', 'Black Market'];

const HEADERS = {
  'User-Agent': 'AlbionWorld-radar/2.0 (+https://github.com/Johandiaz777/albion-world-radar)',
  Accept: 'application/json',
};

/** Parte la lista para que ninguna URL pase de `maxChars` en la parte de ids (ni de `maxIds`). */
export function chunkByLength(ids, maxChars, maxIds = Infinity) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const id of ids) {
    const add = encodeURIComponent(id).length + 1;
    if (current.length && (length + add > maxChars || current.length >= maxIds)) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(id);
    length += add;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Un cliente por región (cada región es otro host, así que corren en paralelo sin sumar al mismo
 * límite). Los pedidos de un cliente van en fila, separados por `gapMs`.
 */
export function createClient(region, { gapMs = 1100, tries = 5, timeoutMs = 45000 } = {}) {
  const host = HOSTS[region];
  const stats = { requests: 0, retries: 0, rateLimited: 0, bytes: 0 };
  let last = 0;

  async function getJson(pathAndQuery) {
    for (let attempt = 1; attempt <= tries; attempt++) {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      stats.requests += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${host}${pathAndQuery}`, { headers: HEADERS, signal: controller.signal });
        if (res.ok) {
          const text = await res.text();
          stats.bytes += text.length;
          return JSON.parse(text);
        }
        if (res.status === 429) {
          stats.rateLimited += 1;
          await sleep(30000 * attempt);
        } else if (res.status >= 400 && res.status < 500) {
          // 4xx que no es límite: la URL está mal; reintentar no lo arregla.
          throw new Error(`HTTP ${res.status} en ${pathAndQuery.slice(0, 80)}`);
        } else {
          await sleep(3000 * attempt);
        }
      } catch (err) {
        if (String(err?.message ?? '').startsWith('HTTP 4')) throw err;
        await sleep(3000 * attempt);
      } finally {
        clearTimeout(timer);
      }
      stats.retries += 1;
    }
    throw new Error(`AODP no respondió tras ${tries} intentos: ${pathAndQuery.slice(0, 80)}`);
  }

  const locations = CITIES.map(encodeURIComponent).join(',');

  /** Precios actuales (calidad 1) de todos los ids en las 8 ciudades. Un trozo que falla no tira la corrida. */
  async function prices(ids, log) {
    const rows = [];
    let failedChunks = 0;
    for (const chunk of chunkByLength(ids, 6000)) {
      try {
        const data = await getJson(`/api/v2/stats/prices/${chunk.map(encodeURIComponent).join(',')}.json?qualities=1&locations=${locations}`);
        if (Array.isArray(data)) rows.push(...data);
      } catch (err) {
        failedChunks += 1;
        log(`trozo de precios perdido (${chunk.length} ids): ${err.message}`);
      }
    }
    return { rows, failedChunks };
  }

  /** Historial diario (time-scale 24) de los últimos `days` días. Devuelve las series crudas. */
  async function history(ids, days) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400e3);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const out = [];
    for (const chunk of chunkByLength(ids, 3000, 50)) {
      const data = await getJson(
        `/api/v2/stats/charts/${chunk.map(encodeURIComponent).join(',')}.json?locations=${locations}&qualities=1&time-scale=24&date=${fmt(start)}&end_date=${fmt(end)}`,
      );
      if (Array.isArray(data)) out.push(...data);
    }
    return out;
  }

  return { region, stats, prices, history };
}
