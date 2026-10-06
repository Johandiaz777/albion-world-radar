// node --test   (sin dependencias)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chunkByLength } from '../lib/aodp.mjs';
import { BM_CITIES, blackMarketOffers, cityTopSellers, craftDeals, quickBlackMarketIds, indexPrices, marketDeals, refineDeals, robustAverage, SLOW_MAX_AGE_MS, transportRoutes } from '../lib/analyze.mjs';
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

test('cosecha: la semilla devuelta (volcado) baja el costo; la orden de venta cuenta la comisión', async () => {
  const { farmDeals } = await import('../lib/analyze.mjs');
  const farm = { yieldPerSeed: 9, crops: [{ seed: 'T5_FARM_CABBAGE_SEED', crop: 'T5_CABBAGE', seedReturn: 0.8 }] };
  // Medido en Américas el 2026-10-01: semilla 11.328, repollo a 446 en orden de compra (17 h).
  const index = indexPrices([row('T5_FARM_CABBAGE_SEED', 'Martlock', 11328, 0, 17), row('T5_CABBAGE', 'Lymhurst', 470, 446, 17, 17), row('T5_CABBAGE', 'Thetford', 480, 0, 5)], NOW, 72 * 3600e3);
  const d = farmDeals(index, farm, NOW).list[0];
  // Antes: 9 × 446 × 0,96 − 11.328 < 0. Ahora la semilla cuesta 11.328 × 0,2 = 2.265,6.
  assert.equal(d.id, 'T5_CABBAGE');
  assert.equal(d.seedReturn, 0.8);
  assert.equal(d.sellPrice, 446);
  assert.deepEqual([d.order.price, d.order.city, d.order.cities], [470, 'Lymhurst', 2]);
  assert.equal(d.weak, false);
  // Sin devolución (zanahoria T1: 0 en el volcado) la semilla entera pesa y no se publica.
  const none = farmDeals(index, { yieldPerSeed: 9, crops: [{ seed: 'T5_FARM_CABBAGE_SEED', crop: 'T5_CABBAGE', seedReturn: 0 }] }, NOW);
  assert.equal(none.list.length, 0);
});

test('cría: hasta 72 h, la cría atípica (mamut) se descarta y una sola ciudad no lidera', async () => {
  const { breedDeals } = await import('../lib/analyze.mjs');
  const farm = {
    feedUnits: 18,
    feedId: 'T5_CABBAGE',
    crops: [],
    animals: [
      { code: 'GOAT', tier: 4, baby: 'T4_FARM_GOAT_BABY', sell: 'T4_MEAT', meatQty: 18, offspring: 0.73 },
      { code: 'MAMMOTH', tier: 8, baby: 'T8_FARM_MAMMOTH_BABY', sell: 'T8_FARM_MAMMOTH_GROWN', offspring: 0.5 },
      { code: 'SHEEP', tier: 6, baby: 'T6_FARM_SHEEP_BABY', sell: 'T6_MEAT', meatQty: 18, offspring: 0.73 },
    ],
  };
  const rows = [
    row('T5_CABBAGE', 'Thetford', 400, 0),
    // Cabra: crías de hace 12-30 h en 2 ciudades (con 12 h no saldría nada).
    row('T4_FARM_GOAT_BABY', 'Martlock', 8130, 0, 30),
    row('T4_FARM_GOAT_BABY', 'Thetford', 7897, 0, 13),
    row('T4_MEAT', 'Caerleon', 900, 800, 20, 20),
    row('T4_MEAT', 'Lymhurst', 950, 0, 20),
    // Mamut: la cría a 10× su promedio → atípica.
    row('T8_FARM_MAMMOTH_BABY', 'Martlock', 30000000, 0),
    row('T8_FARM_MAMMOTH_BABY', 'Lymhurst', 31000000, 0),
    row('T8_FARM_MAMMOTH_GROWN', 'Caerleon', 0, 40000000),
    // Oveja: la carne solo en una ciudad → se publica pero detrás.
    row('T6_FARM_SHEEP_BABY', 'Martlock', 5000, 0),
    row('T6_FARM_SHEEP_BABY', 'Lymhurst', 5200, 0),
    row('T6_MEAT', 'Caerleon', 2000, 0),
  ];
  const avg = { T8_FARM_MAMMOTH_BABY: 3000000 };
  const avg30 = (id) => avg[id] ?? null;
  const { list } = breedDeals(indexPrices(rows, NOW, 72 * 3600e3), farm, NOW, { avg30 });
  assert.deepEqual(list.map((d) => d.animal), ['GOAT', 'SHEEP']);
  const goat = list[0];
  assert.equal(goat.weak, false);
  assert.equal(goat.baby.cities, 2);
  assert.equal(goat.baby.price, 7897);
  assert.equal(list[1].weak, true);
  // Con el índice de 12 h de siempre, la cabra no sale (sus crías tienen más de 12 h).
  assert.ok(!breedDeals(indexPrices(rows, NOW), farm, NOW, { avg30 }).list.some((d) => d.animal === 'GOAT'));
});

test('carnear con orden de venta: el adulto de hace 40 h cuenta; poción sigue con 12 h', async () => {
  const { makeDeals, SLOW_MAX_AGE_MS } = await import('../lib/analyze.mjs');
  const rows = [
    row('T4_FARM_GOAT_GROWN', 'Martlock', 10000, 0, 40),
    row('T4_MEAT', 'Caerleon', 700, 500, 2, 2),
    row('T4_MEAT', 'Lymhurst', 720, 0, 2),
  ];
  const make = [{ id: 'T4_MEAT', kind: 'butcher', n: 18, res: [['T4_FARM_GOAT_GROWN', 1]] }];
  const slow = makeDeals(indexPrices(rows, NOW), make, 0.15, NOW, { slowIndex: indexPrices(rows, NOW, SLOW_MAX_AGE_MS) }).list[0];
  // Inmediata: 18 × 500 × 0,96 − 10.000 < 0; con orden: 18 × 700 × 0,935 − 10.000 = 1.781.
  assert.equal(slow.kind, 'butcher');
  assert.equal(slow.sellPrice, 500);
  assert.equal(slow.order.price, 700);
  assert.equal(makeDeals(indexPrices(rows, NOW), make, 0.15, NOW).list.length, 0);
});

test('Mercado Negro: cada oferta con su comparación; fuera trols, rellenos y datos rotos', () => {
  const rows = [
    // Bolsa: el MN paga 2.000; Martlock compra ya a 1.500 (hace 30 h: vale del lado de las ciudades) y
    // Lymhurst vende a 1.200 (para revender).
    row('T4_BAG', 'Black Market', 0, 2000, 1, 2),
    row('T4_BAG', 'Martlock', 0, 1500, 1, 30),
    row('T4_BAG', 'Lymhurst', 1200, 0),
    // Orden de relleno en una ciudad (<10 % del MN) y venta absurda (revender daría >300 %): no cuentan.
    row('T4_BAG', 'Thetford', 100, 150),
    // Espada: orden del MN 3× sobre lo que pagó en promedio = trol.
    row('T4_MAIN_SWORD', 'Black Market', 0, 90000),
    // Capa: orden del MN de hace 20 h = vieja, no se publica.
    row('T4_CAPE', 'Black Market', 0, 5000, 1, 20),
  ];
  const index = indexPrices(rows, NOW);
  const slowIndex = indexPrices(rows, NOW, SLOW_MAX_AGE_MS);
  const avgs = { 'T4_BAG|Black Market': 1800, 'T4_BAG|Martlock': 1400, 'T4_BAG|Lymhurst': 1300, 'T4_MAIN_SWORD|Black Market': 20000 };
  const avg30 = (id, city) => avgs[`${id}|${city}`] ?? null;
  const { candidates, list } = blackMarketOffers(index, NOW, { slowIndex, avg30 });
  assert.equal(candidates, 2);
  assert.equal(list.length, 1);
  const [id, price, age, bmAvg, cityAvg, instant, instantCity, instantAge, cheap, cheapCity, cheapAge] = list[0];
  assert.equal(id, 'T4_BAG');
  assert.equal(price, 2000);
  assert.equal(age, 120);
  assert.equal(bmAvg, 1800);
  assert.equal(cityAvg, 1350);
  assert.equal(instant, 1500);
  assert.equal(BM_CITIES[instantCity], 'Martlock');
  assert.equal(instantAge, 30 * 60);
  assert.equal(cheap, 1200);
  assert.equal(BM_CITIES[cheapCity], 'Lymhurst');
  assert.equal(cheapAge, 60);
});

test('vuelta rápida: las órdenes del Mercado Negro que más pagan, sin repetir, solo del catálogo y con tope', () => {
  const known = new Set(['T8_BAG', 'T7_BAG', 'T6_BAG', 'T5_BAG']);
  const rows = [['T8_BAG', 9000], ['T8_BAG', 8000], ['T_FUERA', 7000], ['T7_BAG', 6000], 'roto', [null, 1], ['T6_BAG', 5000], ['T5_BAG', 4000]];
  assert.deepEqual(quickBlackMarketIds(rows, known, 3), ['T8_BAG', 'T7_BAG', 'T6_BAG']);
  assert.deepEqual(quickBlackMarketIds(undefined, known), []);
  assert.deepEqual(quickBlackMarketIds(rows, known, 0), []);
});

test('cityTopSellers: por ciudad, por plata movida, con mínimo de ventas y sin Mercado Negro', () => {
  const index = new Map([['A', {}], ['B', {}], ['C', {}], ['D', {}]]);
  const stats = {
    'A|Lymhurst': { volume7: 1000, avg30: 10 }, // 10.000
    'B|Lymhurst': { volume7: 7, avg30: 5000 }, // 35.000
    'C|Lymhurst': { volume7: 2, avg30: 1e7 }, // una venta suelta carísima: fuera
    'D|Lymhurst': { volume7: 50, avg30: 0 }, // sin promedio: fuera
    'A|Black Market': { volume7: 999, avg30: 999 },
  };
  const statsOf = (id, city) => stats[`${id}|${city}`] ?? null;
  const out = cityTopSellers(index, statsOf, ['Lymhurst', 'Martlock', 'Black Market'], { top: 5 });
  assert.deepEqual(out.Lymhurst, [['B', 7, 5000], ['A', 1000, 10]]);
  assert.deepEqual(out.Martlock, []);
  assert.equal('Black Market' in out, false);
  assert.equal(cityTopSellers(index, statsOf, ['Lymhurst'], { top: 1 }).Lymhurst.length, 1);
});
