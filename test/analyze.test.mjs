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

test('cosecha: 9 cultivos por semilla; cría: bebé + 18 de alimento contra la venta', async () => {
  const { farmDeals, breedDeals } = await import('../lib/analyze.mjs');
  const farm = {
    yieldPerSeed: 9,
    feedUnits: 18,
    feedId: 'T5_CABBAGE',
    crops: [{ seed: 'T4_FARM_TURNIP_SEED', crop: 'T4_TURNIP' }],
    animals: [{ code: 'GOAT', tier: 4, baby: 'T4_FARM_GOAT_BABY', sell: 'T4_MEAT' }],
  };
  const index = indexPrices(
    [
      row('T4_FARM_TURNIP_SEED', 'Martlock', 1000, 0),
      row('T4_TURNIP', 'Lymhurst', 250, 200),
      row('T5_CABBAGE', 'Thetford', 100, 0),
      row('T4_FARM_GOAT_BABY', 'Bridgewatch', 3000, 0),
      row('T4_MEAT', 'Caerleon', 6500, 6000),
    ],
    NOW,
  );
  assert.equal(farmDeals(index, farm, NOW).list[0].yield, 9);
  const breed = breedDeals(index, farm, NOW).list[0];
  assert.equal(breed.feed.q, 18);
  assert.equal(breed.sellPrice, 6000);
});

test('cría por especie: carne × carnicero + cría devuelta; carnívoros comen carne (BK.11 B)', async () => {
  const { breedDeals } = await import('../lib/analyze.mjs');
  const farm = {
    feedUnits: 18,
    feedId: 'T5_CABBAGE',
    animals: [
      { code: 'GOAT', tier: 4, baby: 'T4_FARM_GOAT_BABY', sell: 'T4_MEAT', feedId: 'T5_CABBAGE', feedUnits: 18, offspring: 0.7333, meatQty: 18 },
      { code: 'DIREWOLF', tier: 6, baby: 'T6_FARM_DIREWOLF_BABY', sell: 'T6_FARM_DIREWOLF_GROWN', feedId: 'T6_MEAT', feedUnits: 64, offspring: 0, meatQty: 1 },
    ],
  };
  const index = indexPrices(
    [
      row('T5_CABBAGE', 'Thetford', 100, 0),
      row('T4_FARM_GOAT_BABY', 'Bridgewatch', 3000, 0),
      // 1 carne a 300: con el modelo viejo (1 carne) era pérdida; con 18 carnes + cría devuelta, gana.
      row('T4_MEAT', 'Caerleon', 320, 300),
      row('T6_MEAT', 'Martlock', 200, 0),
      row('T6_FARM_DIREWOLF_BABY', 'Lymhurst', 50000, 0),
      row('T6_FARM_DIREWOLF_GROWN', 'Lymhurst', 90000, 80000),
    ],
    NOW,
  );
  const list = breedDeals(index, farm, NOW).list;
  const goat = list.find((d) => d.animal === 'GOAT');
  assert.ok(goat, 'la cabra da margen con 18 carnes y cría devuelta');
  assert.equal(goat.sellPrice, 300);
  const wolf = list.find((d) => d.animal === 'DIREWOLF');
  assert.ok(wolf);
  assert.deepEqual([wolf.feed.id, wolf.feed.q], ['T6_MEAT', 64]);
});

test('itemValues: mediana de promedios entre ciudades, o de la venta fresca, sin el Mercado Negro', async () => {
  const { itemValues } = await import('../lib/analyze.mjs');
  const avg = { 'A|Caerleon': 100, 'A|Martlock': 120, 'A|Thetford': 400, 'A|Black Market': 9999 };
  const index = new Map([['B', { sells: [{ sell_price_min: 50 }, { sell_price_min: 70 }], buys: [] }]]);
  const out = itemValues(['A', 'B', 'C'], (id, c) => avg[`${id}|${c}`] ?? null, index, ['Caerleon', 'Martlock', 'Thetford', 'Black Market']);
  assert.deepEqual(out, { A: 120, B: 60 });
});

test('monturas y consumibles: la montura no tiene devolución; la cocina sí, y cuenta las unidades hechas', async () => {
  const { makeDeals } = await import('../lib/analyze.mjs');
  const index = indexPrices(
    [
      row('T5_MOUNT_HORSE', 'Lymhurst', 0, 60000),
      row('T5_FARM_HORSE_GROWN', 'Martlock', 30000, 0),
      row('T5_LEATHER', 'Martlock', 1000, 0),
      row('T6_POTION_ENERGY', 'Caerleon', 0, 2000),
      row('T6_FOXGLOVE', 'Lymhurst', 60, 0),
      row('T6_MILK', 'Lymhurst', 100, 0),
      row('T6_ALCOHOL', 'Lymhurst', 100, 0),
      row('T4_MEAL_SOUP', 'Caerleon', 0, 100),
      row('T4_CARROT', 'Lymhurst', 500, 0),
    ],
    NOW,
  );
  const make = [
    { id: 'T5_MOUNT_HORSE', kind: 'mount', n: 1, res: [['T5_FARM_HORSE_GROWN', 1], ['T5_LEATHER', 20]] },
    { id: 'T6_POTION_ENERGY', kind: 'potion', n: 5, res: [['T6_FOXGLOVE', 72], ['T6_MILK', 18], ['T6_ALCOHOL', 18]] },
    // Pierde plata: no se publica.
    { id: 'T4_MEAL_SOUP', kind: 'meal', n: 1, res: [['T4_CARROT', 16]] },
    // Sin precio de un material: no se publica.
    { id: 'T5_MOUNT_OX', kind: 'mount', n: 1, res: [['T5_FARM_OX_GROWN', 1], ['T5_PLANKS', 30]] },
  ];
  const { list, candidates } = makeDeals(index, make, 0.15, NOW);
  assert.equal(candidates, 2);
  const mount = list.find((d) => d.id === 'T5_MOUNT_HORSE');
  // 60000 × 0,96 − (30000 + 20 × 1000) = 7600 → se publica, sin devolución.
  assert.equal(mount.kind, 'mount');
  assert.equal(mount.resources.length, 2);
  assert.equal(mount.sellPrice, 60000);
  const potion = list.find((d) => d.id === 'T6_POTION_ENERGY');
  // 5 × 2000 × 0,96 − (72×60 + 18×100 + 18×100) × 0,85 = 9600 − 6732 = 2868.
  assert.equal(potion.n, 5);
  assert.equal(list[0].id, 'T5_MOUNT_HORSE');
  assert.ok(!list.some((d) => d.id === 'T4_MEAL_SOUP'));
});

test('monturas y consumibles: un catálogo roto se salta sin publicar NaN ni lanzar', async () => {
  const { makeDeals } = await import('../lib/analyze.mjs');
  const index = indexPrices([row('T5_MOUNT_HORSE', 'Lymhurst', 0, 60000), row('T5_LEATHER', 'Martlock', 1000, 0)], NOW);
  const make = [
    { id: 'T5_MOUNT_HORSE', kind: 'mount', res: [['T5_LEATHER', 20]] },
    { id: 'T5_MOUNT_HORSE', kind: 'mount', n: 1, res: 'roto' },
    { id: 'T5_MOUNT_HORSE', kind: 'mount', n: 1, res: [['T5_LEATHER']] },
    { id: 'T5_MOUNT_HORSE', kind: 'mount', n: 1, res: [] },
    null,
  ];
  const { list, candidates } = makeDeals(index, make, 0.15, NOW);
  assert.equal(candidates, 0);
  assert.equal(list.length, 0);
});
