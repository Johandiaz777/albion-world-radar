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

// El límite de AODP (180/min y 300 cada 5 min) es por IP, y las 3 regiones salen del mismo runner:
// un solo turno COMPARTIDO entre todos los clientes (~285 pedidos cada 5 min). Medido: con un ritmo
// por región la primera corrida recibió 429.
const GLOBAL_GAP_MS = 1050;
let nextSlot = 0;
async function takeSlot() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + GLOBAL_GAP_MS;
  if (slot > now) await sleep(slot - now);
}

/**
 * Un cliente por región. Las regiones corren en paralelo pero comparten el turno global de pedidos.
 */
export function createClient(region, { tries = 5, timeoutMs = 45000 } = {}) {
  const host = HOSTS[region];
  const stats = { requests: 0, retries: 0, rateLimited: 0, bytes: 0 };

  async function getJson(pathAndQuery) {
    for (let attempt = 1; attempt <= tries; attempt++) {
      await takeSlot();
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
          // Auditoría p92 H2: el límite es por IP y las 3 regiones comparten el turno: la espera frena el
          // turno GLOBAL, no solo a esta región (antes las otras dos seguían pidiendo y alargaban los 429).
          nextSlot = Math.max(nextSlot, Date.now() + 30000 * attempt);
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

  /** Precios actuales (calidad 1, salvo que se pidan otras) de todos los ids en las 8 ciudades (o en
   * `places`). Un trozo que falla no tira la corrida. */
  async function prices(ids, log, { qualities = [1], places = null } = {}) {
    const rows = [];
    let failedChunks = 0;
    const where = places ? places.map(encodeURIComponent).join(',') : locations;
    for (const chunk of chunkByLength(ids, 6000)) {
      try {
        const data = await getJson(`/api/v2/stats/prices/${chunk.map(encodeURIComponent).join(',')}.json?qualities=${qualities.join(',')}&locations=${where}`);
        if (Array.isArray(data)) rows.push(...data);
      } catch (err) {
        failedChunks += 1;
        log(`trozo de precios perdido (${chunk.length} ids): ${err.message}`);
      }
    }
    return { rows, failedChunks };
  }

  /** Historial diario (time-scale 24) de los últimos `days` días. Devuelve las series crudas. Por defecto
   * las 8 ubicaciones y calidad Normal; `places`/`qualities` para pedir solo una parte (Mercado Negro). */
  async function history(ids, days, { places = null, qualities = [1] } = {}) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400e3);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const out = [];
    for (const chunk of chunkByLength(ids, 3000, 50)) {
      const data = await getJson(
        `/api/v2/stats/charts/${chunk.map(encodeURIComponent).join(',')}.json?locations=${places ? places.map(encodeURIComponent).join(',') : locations}&qualities=${qualities.join(',')}&time-scale=24&date=${fmt(start)}&end_date=${fmt(end)}`,
      );
      if (Array.isArray(data)) out.push(...data);
    }
    return out;
  }

  return { region, stats, prices, history };
}
