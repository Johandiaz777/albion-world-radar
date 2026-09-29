# albion-world-radar

Escáner de mercado de **Albion World**. Corre 24/7 en GitHub Actions y cada 30 minutos (en :07 y :37 UTC)
revisa **todo el mercado** de las 3 regiones en [AODP](https://www.albion-online-data.com/):

| Qué | Cuánto |
|---|---|
| Ítems | 3.694 base + variantes encantadas .1-.4 = **9.638 ids** × 8 ciudades |
| Transporte | comprar en la venta más barata, vender a la mejor orden de compra de otra ciudad |
| Gangas | ciudad donde un ítem está más barato que **su propio promedio de 30 días** (todas las ciudades de todos los ítems) |
| Crafteo | 226 recetas × T4-T8 × .0-.4, con artefactos y recursos del mismo encantamiento |
| Refinado | 5 recursos × T4-T8 × .0-.4 (piedra solo .0), sin foco |

## Qué publica

- Rama `data`: `americas.json`, `europe.json`, `asia.json` (~70 KB c/u, formato `v: 2`) y `status.json`
  (salud por región: pedidos, reintentos, 429, filas, cobertura del promedio, candidatos, errores).
- Rama `state`: `<region>.json.gz` con el promedio de 30 días de cada ítem-ciudad. Se refresca en rotación:
  una porción en cada corrida (todo el catálogo cada ~24 h; al arrancar, 3.000 ids por corrida hasta cubrirlo).

La app lee `https://raw.githubusercontent.com/Johandiaz777/albion-world-radar/data/<region>.json`. Si el
archivo falta, no valida o tiene más de 2 h, vuelve a su escaneo propio de siempre.

## Por qué no se rompe (lecciones del scraper de kills)

- **Sin pull/rebase/merge**: cada publicación es UN commit reescrito con `push -f`. No pueden aparecer
  marcadores de conflicto dentro de los JSON y el repositorio no crece. Aun así, se revisan antes de publicar.
- **Lectura tolerante**: un archivo de estado faltante, vacío, truncado o con conflicto se ignora (se reconstruye).
- **Escritura atómica** (temporal + rename).
- **Fallos aislados**: cada región es otro host y corre aparte; si una falla se conserva su último archivo y
  `status.json` lo marca. Un trozo de precios perdido no tira la corrida.
- **Límite de AODP** (180/min y 300 cada 5 min): 1 pedido cada 1,1 s por host, pedidos agrupados por largo
  de URL, reintentos con espera creciente y 30 s+ ante 429.
- **24/7**: el job vive ~5h40m y se re-lanza solo; cron cada 4 h como red de seguridad. Si el bucle muere
  enseguida no se encadena (evita un bucle de corridas).

## Local

```bash
npm test                              # pruebas del análisis (sin red)
node scan.mjs americas --limit 400    # prueba rápida
node scan.mjs                         # las 3 regiones (~1,5 min en paralelo)
```

`catalog.json` se genera desde la app: `node scripts/export-radar-catalog.mjs` (ids, recetas y constantes de
refinado salen de los datos de la app, así el Radar del teléfono y el escáner hablan de los mismos ítems).
