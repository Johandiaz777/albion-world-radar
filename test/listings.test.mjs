// node --test   (sin dependencias)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { KEEP_DAYS, dayNumber, mergeDay, recordListings, writeClosedDay } from '../lib/listings.mjs';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const TODAY = dayNumber(NOW);
const cityIndex = new Map([['Caerleon', 0], ['Black Market', 6]]);
const at = (h) => new Date(NOW - h * 3600e3).toISOString().slice(0, 19); // formato AODP, sin Z
const row = (item_id, city, sell, buy, hSell = 1, hBuy = 1) => ({
  item_id,
  city,
  quality: 1,
  sell_price_min: sell,
  sell_price_min_date: sell ? at(hSell) : '0001-01-01T00:00:00',
  buy_price_max: buy,
  buy_price_max_date: buy ? at(hBuy) : '0001-01-01T00:00:00',
});

test('guarda el más barato y la mejor compra del día, solo lo visto hoy', () => {
  let { buffer } = recordListings(null, [row('T5_X', 'Caerleon', 15000, 9000)], cityIndex, NOW);
  ({ buffer } = recordListings(buffer, [row('T5_X', 'Caerleon', 14889, 9500), row('T5_X', 'Black Market', 0, 18012)], cityIndex, NOW));
  ({ buffer } = recordListings(buffer, [row('T5_X', 'Caerleon', 16000, 8000)], cityIndex, NOW));
  assert.deepEqual(buffer.p['T5_X|0'], [14889, 9500]);
  assert.deepEqual(buffer.p['T5_X|6'], [0, 18012]);
  // Precio de ayer (20 h antes de las 12:00 UTC = otro día): no cuenta.
  const old = recordListings(null, [row('T5_Y', 'Caerleon', 100, 0, 20)], cityIndex, NOW);
  assert.equal(old.buffer.p['T5_Y|0'], undefined);
});

test('al cambiar de día entrega el anterior para escribirlo', () => {
  const { buffer } = recordListings(null, [row('T5_X', 'Caerleon', 100, 0)], cityIndex, NOW);
  const next = recordListings(buffer, [], cityIndex, NOW + 86400e3);
  assert.equal(next.closed.day, TODAY);
  assert.equal(next.buffer.day, TODAY + 1);
  assert.deepEqual(next.buffer.p, {});
});

test('mergeDay es idempotente y recorta a KEEP_DAYS', () => {
  const old = { v: 1, c: { 0: [[TODAY - KEEP_DAYS - 5, 1, 1], [TODAY - 1, 5, 4]] } };
  const a = mergeDay(old, 'T5_X', 'americas', TODAY, { 0: [7, 6], 6: [0, 9] });
  const b = mergeDay(a, 'T5_X', 'americas', TODAY, { 0: [8, 6] });
  assert.deepEqual(b.c[0], [[TODAY - 1, 5, 4], [TODAY, 8, 6]]);
  assert.deepEqual(b.c[6], [[TODAY, 0, 9]]);
  assert.deepEqual(mergeDay({ roto: true }, 'T5_X', 'americas', TODAY, { 0: [1, 0] }).c, { 0: [[TODAY, 1, 0]] });
});

test('writeClosedDay escribe un archivo por ítem, con @ en el nombre', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listings-'));
  const n = writeClosedDay(dir, 'americas', { day: TODAY, p: { 'T5_X|0': [10, 0], 'T5_X@1|6': [0, 20], 'T5_X|6': [0, 30] } });
  assert.equal(n, 2);
  const x = JSON.parse(fs.readFileSync(path.join(dir, 'T5_X.json'), 'utf8'));
  assert.deepEqual(x.c, { 0: [[TODAY, 10, 0]], 6: [[TODAY, 0, 30]] });
  assert.ok(fs.existsSync(path.join(dir, 'T5_X@1.json')));
});

test('compacta lo viejo por semana completa y es idempotente (auditoría A1)', async () => {
  const { compactSeries, DAILY_DAYS } = await import('../lib/listings.mjs');
  const day = 21000; // múltiplo de 7 = inicio de semana
  // 370 días seguidos con precio = día (venta) y día/2 (compra).
  const series = [];
  for (let d = day - 369; d <= day; d++) series.push([d, d, Math.round(d / 2)]);
  const out = compactSeries(series, day);
  const daily = out.filter((p) => p[0] >= day - DAILY_DAYS + 1);
  assert.equal(daily.length, DAILY_DAYS);
  assert.ok(out.length < 90, `quedaron ${out.length} puntos`);
  // Ordenado, sin repetidos, y la semana compactada usa la mediana de sus días.
  for (let i = 1; i < out.length; i++) assert.ok(out[i][0] > out[i - 1][0]);
  const w = out.find((p) => p[0] > day - 300 && p[0] < day - DAILY_DAYS && p[0] % 7 === 6);
  // Semana completa de 7 días (w[0]-6 … w[0]): mediana = el día del medio.
  assert.deepEqual(w, [w[0], w[0] - 3, Math.round((w[0] - 3) / 2)]);
  // Idempotente: compactar de nuevo no cambia nada.
  assert.deepEqual(compactSeries(out, day), out);
  // Los ceros (sin dato ese lado) no cuentan en la mediana.
  const gaps = compactSeries([[day - 105, 100, 0], [day - 104, 0, 50], [day - 103, 300, 0]], day);
  assert.deepEqual(gaps.map((p) => [p[1], p[2]]), [[200, 50]]);
});

test('mergeDay mantiene el formato que lee la app', () => {
  const day = 21000;
  let file = null;
  for (let d = day - 100; d <= day; d++) file = mergeDay(file, 'T4_BAG', 'americas', d, { 0: [d, 0] });
  assert.equal(file.v, 1);
  const pts = file.c['0'];
  assert.ok(pts.length < 60 && pts.length >= 35);
  assert.deepEqual(pts[pts.length - 1], [day, day, 0]);
});
