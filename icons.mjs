// Espejo de íconos de Albion World (parte 84 de la app).
//
// Por qué: render.albiononline.com es UN servidor en Europa sin CDN y desde Colombia/Venezuela falla
// la mayoría de los pedidos (medido 2026-10-06 y 2026-10-07: 3 de 4 sin conexión en 25 s). Este
// script corre en GitHub Actions (red estable), baja los íconos del catálogo una sola vez y el
// workflow `icons.yml` los convierte a WebP y los deja como artefacto. Se publican en Firebase
// Hosting (sitio `albion-world-icons`) desde la PC del dueño con la sesión de la CLI: no se guarda
// ninguna credencial de Firebase en GitHub.
//
// Mismas reglas que la app (src/services/icon-mirror.ts): calidad 1, 128 px, nombre `<ID>.png` o
// `<ID>@<n>.png`. Cuidado con el servidor de íconos: 4 pedidos a la vez, reintentos con espera y
// tope de 20 s por pedido. Lo que falle queda fuera del espejo y la app lo pide al render oficial.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = process.argv[2] ?? 'icons-png';
const CONCURRENCY = 4;
const TIMEOUT_MS = 20_000;
const ATTEMPTS = 4;
const ID_RE = /^[A-Z0-9][A-Z0-9_]{1,78}(@[1-4])?$/;
const HEADERS = { 'User-Agent': 'AlbionWorld-icons/1.0 (+https://github.com/Johandiaz777/albion-world-radar)' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/** 'ok' | 'missing' (el render no tiene ese ícono) | 'failed' (red). */
async function fetchIcon(id) {
  const file = join(OUT, `${id}.png`);
  if (await exists(file)) return 'ok';
  const url = `https://render.albiononline.com/v1/item/${encodeURIComponent(id)}.png?quality=1&size=128`;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 404) return 'missing';
      if (res.ok && (res.headers.get('content-type') ?? '').startsWith('image/png')) {
        const buf = Buffer.from(await res.arrayBuffer());
        // Firma PNG: nunca publicar una página de error con extensión .png.
        if (buf.length > 100 && buf[0] === 0x89 && buf[1] === 0x50) {
          await writeFile(file, buf);
          return 'ok';
        }
      }
    } catch {
      /* red: se reintenta */
    }
    await sleep(1000 * 2 ** attempt);
  }
  return 'failed';
}

const catalog = JSON.parse(await readFile(new URL('./catalog.json', import.meta.url), 'utf8'));
const ids = [...new Set(catalog.ids)].filter((id) => ID_RE.test(id));
await mkdir(OUT, { recursive: true });

const counts = { ok: 0, missing: 0, failed: 0 };
const failed = [];
let next = 0;
const started = Date.now();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const result = await fetchIcon(id);
      counts[result]++;
      if (result !== 'ok') failed.push(`${result} ${id}`);
      const done = counts.ok + counts.missing + counts.failed;
      if (done % 500 === 0) console.log(`${done}/${ids.length} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
  }),
);

await writeFile(join(OUT, '..', 'icons-report.txt'), failed.sort().join('\n') + '\n');
console.log(`Listo: ${counts.ok} íconos, ${counts.missing} sin ícono en el render, ${counts.failed} fallidos (de ${ids.length}).`);
// Si falla más del 5 %, algo anda mal con el render: no se publica un espejo a medias.
if (counts.failed > ids.length * 0.05) process.exit(1);
