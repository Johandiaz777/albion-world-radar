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
| Cosecha | los 15 cultivos (9 por semilla con Premium) |
| Cría | 44 animales/tiers (granja clásica a carne; monturas y salvajes, crecidos) |
| Cayó fuerte | lo mismo que Gangas contra el promedio de **7, 90 y 180 días** (`drops7`, `drops90`, `drops180`) |
| Tendencias | lo que más sube y más baja (mediana de 14 días contra los 14 anteriores) con proyección a 7 días cuando la tendencia es consistente (R² ≥ 0,3, acotada ±30 %) |
| Más movidos | los 100 ítems que más plata movieron en 7 días, dónde se venden más y la ciudad que mejor paga hoy |

## Qué publica

- Rama `data`: `<region>-top.json` (lo mejor de cada tarjeta, ~2 KB: lo que baja la pantalla del Radar),
  `<region>.json` (todas las listas, ~100 KB / ~13 KB comprimido: "Ver más", "Cayó fuerte") y `status.json`
  (salud por región: pedidos, reintentos, 429, filas, cobertura del promedio, candidatos, errores).
- Rama `history`: `<region>/<fecha>.json.gz`, el precio medio de cada ítem-ciudad de cada día (~150 KB por
  día y región). Solo se agregan archivos, nunca se reescriben: sirve para 90/180 días, tendencias y proyecciones.
- Rama `listings`: `<region>/<id>.json`, el **precio publicado** de cada día (venta más barata y mejor orden de
  compra, solo lo visto ese día) de cada ítem-ciudad, 370 días. El historial de AODP son ventas que suben los
  jugadores y hay ciudades que pasan meses sin una (Caerleon, Túnica de clérigo T5, Américas: última el
  17/06/2026); esto llena ese hueco. Se escribe una vez por día y se publica con `push -f`; si la rama no se
  pudo traer, los días esperan en el estado (hasta 3) en vez de publicar una carpeta vacía.
- Rama `state`: `<region>.json.gz` con los promedios de 7/30/90/180 días, tendencia, volumen y proyección de
  cada ítem-ciudad (salen del historial diario de 180 días de la API, pedido en rotación). Se refresca en rotación:
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
- **Límite de AODP** (180/min y 300 cada 5 min, por IP): un turno compartido entre las 3 regiones (1 pedido
  cada 1,05 s), pedidos agrupados por largo
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
