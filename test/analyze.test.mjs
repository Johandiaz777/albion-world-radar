// node --test   (sin dependencias)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chunkByLength } from '../lib/aodp.mjs';
import { craftDeals, indexPrices, marketDeals, refineDeals, robustAverage, transportRoutes } from '../lib/analyze.mjs';
import { hasConflictMarkers } from '../lib/store.mjs';

const NOW = Date.parse('2026-09-29T12:00:00Z');
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

test('trozos por largo de URL', () => {
  const ids = Array.from({ length: 500 }, (_, i) => `T4_ITEM_${i}`);
  const chunks = chunkByLength(ids, 1000);
  assert.equal(chunks.flat().length, 500);
  for (const c of chunks) assert.ok(c.map(encodeURIComponent).join(',').length <= 1000);
  assert.ok(chunkByLength(ids, 100000, 50).every((c) => c.length <= 50));
});

test('promedio robusto igual al de la app', () => {
  assert.equal(robustAverage([100, 100, 100, 100]), null);
  assert.equal(robustAverage([100, 110, 90, 100, 100, 100000]), 100);
});

test('transporte: compra la venta más barata y vende a la mejor orden; ignora viejos y trols', () => {
  const index = indexPrices(
    [
      row('T4_BAG', 'Martlock', 1000, 0),
      row('T4_BAG', 'Lymhurst', 1200, 1500),
      row('T4_BAG', 'Thetford', 1100, 99999), // orden absurda (>3× mediana)
      row('T4_BAG', 'Caerleon', 900, 0, 20), // venta de hace 20 h: no cuenta
    ],
    NOW,
  );
  const { list } = transportRoutes(index, NOW);
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].buyCity, list[0].sellCity, list[0].buyPrice, list[0].sellPrice], ['Martlock', 'Lymhurst', 1000, 1500]);
});

test('gangas: precio por debajo de SU promedio de 30 días', () => {
  const index = indexPrices([row('T5_CAPE', 'Bridgewatch', 800, 0), row('T5_CAPE', 'Martlock', 1000, 0)], NOW);
  const avg = { 'T5_CAPE|Bridgewatch': 1000, 'T5_CAPE|Martlock': 1000 };
  const { list } = marketDeals(index, (id, city) => avg[`${id}|${city}`] ?? null, NOW);
  assert.deepEqual(list.map((d) => [d.city, d.price, d.avg]), [['Bridgewatch', 800, 1000]]);
});

test('crafteo encantado usa recursos del mismo encantamiento y cobra el artefacto', () => {
  const index = indexPrices(
    [
      row('T5_PLANKS_LEVEL1@1', 'Fort Sterling', 1000, 0),
      row('T5_ARTEFACT_2H_BOW_KEEPER', 'Caerleon', 5000, 0),
      row('T5_2H_BOW_KEEPER@1', 'Black Market', 0, 40000),
      row('T5_2H_BOW_KEEPER@1', 'Lymhurst', 30000, 0),
    ],
    NOW,
  );
  const { list } = craftDeals(index, [{ base: '2H_BOW_KEEPER', artifact: '2H_BOW_KEEPER', resources: { PLANKS: 32 } }], 0.15, NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].resources[0].id, 'T5_PLANKS_LEVEL1@1');
  assert.equal(list[0].artifact.price, 5000);
  assert.equal(list[0].sellCity, 'Black Market');
});

test('crafteo sin precio del artefacto no se publica', () => {
  const index = indexPrices([row('T4_PLANKS', 'Martlock', 100, 0), row('T4_2H_BOW_KEEPER', 'Black Market', 0, 90000), row('T4_2H_BOW_KEEPER', 'Lymhurst', 60000, 0)], NOW);
  const { list } = craftDeals(index, [{ base: '2H_BOW_KEEPER', artifact: '2H_BOW_KEEPER', resources: { PLANKS: 32 } }], 0.15, NOW);
  assert.equal(list.length, 0);
});

test('refinado T4 encantado usa T3 sin encantar como sub-material', () => {
  const refining = {
    returnRate: 0.367,
    tierRatios: { 4: { raw: 2, sub: 1, output: 1 } },
    resources: { Madera: { raw: 'WOOD', refined: 'PLANKS', bonusCity: 'Fort Sterling' } },
  };
  const index = indexPrices(
    [
      row('T4_WOOD_LEVEL1@1', 'Martlock', 300, 0),
      row('T3_PLANKS', 'Martlock', 100, 0),
      row('T4_PLANKS_LEVEL1@1', 'Lymhurst', 1400, 1200),
    ],
    NOW,
  );
  const { list } = refineDeals(index, refining, NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].sub.id, 'T3_PLANKS');
  assert.equal(list[0].enchant, 1);
});

test('detecta marcadores de conflicto', () => {
  assert.ok(hasConflictMarkers('{\n<<<<<<< HEAD\n}'));
  assert.ok(!hasConflictMarkers('{"a":"<<<<<<<"}'));
});
