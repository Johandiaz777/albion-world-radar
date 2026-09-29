// Lectura/escritura tolerante (misma lección del scraper de kills: un archivo roto no puede tumbar
// ni envenenar las corridas siguientes). Leer un archivo faltante, vacío, truncado o con marcadores
// de conflicto devuelve el valor por defecto; escribir es atómico (archivo temporal + rename).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export function hasConflictMarkers(text) {
  return /^(<<<<<<< |>>>>>>> |=======$)/m.test(text);
}

export function readJson(file, fallback, log = () => {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    let buf = fs.readFileSync(file);
    if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
    const text = buf.toString('utf8');
    if (!text.trim() || hasConflictMarkers(text)) {
      log(`${path.basename(file)} vacío o dañado: se ignora`);
      return fallback;
    }
    return JSON.parse(text);
  } catch (err) {
    log(`${path.basename(file)} ilegible (${err.message}): se ignora`);
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let buf = Buffer.from(JSON.stringify(value));
  if (file.endsWith('.gz')) buf = zlib.gzipSync(buf, { level: 9 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return buf.length;
}
