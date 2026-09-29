# albion-world-radar

Escáner de mercado de **Albion World**. Cada 30 minutos (GitHub Actions) pide a
[AODP](https://www.albion-online-data.com/) los precios de todo el catálogo comerciable
(3.694 ítems × 8 ciudades) en las 3 regiones y publica en la rama `data` un JSON pequeño por región:

- `transport`: mejores rutas "compra en A, vende a la orden de compra de B" (precios brutos).
- `market`: ciudades donde un ítem está más barato que su propio promedio de 30 días
  (candidatos confirmados con el historial diario real).

La app lee `https://raw.githubusercontent.com/Johandiaz777/albion-world-radar/data/<region>.json`
y, si el archivo falta o tiene más de 2 h, vuelve a su lista fija de siempre.

- Sin secretos ni Firebase. Repo público: Actions gratis.
- La rama `data` es un solo commit reescrito cada vez: el repositorio no crece.
- Si una región falla, se conserva su archivo anterior.
- Prueba local: `node scan.mjs americas` (≈45 s, ~42 pedidos). Rápida: `--limit 300`.
- `item-ids.json` sale del catálogo de la app (`items.json`, ítems comerciables sin encantar).
