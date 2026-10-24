# Créditos y atribuciones

## Dataset de BINs — `datos/bins.db`

Este proyecto usa **binlist-data** de Techbuddie Solutions:

- Repositorio: https://github.com/Techbuddie-Solutions/binlist-data
- Licencia: **Creative Commons Attribution 4.0 International (CC BY 4.0)**
- Uso: banco emisor, red, tipo, nivel y país por BIN.
- Fecha del dataset importado: **2026-09-03** (`summary.json`).

`binlist-data` es a su vez una fusión de dos datasets CC BY 4.0:

- **iannuttall/binlist-data** — Ian Nuttall, CC BY 4.0.
- **venelinkochev/bin-list-data** — Venelin Kochev, CC BY 4.0.

La atribución se mantiene en este archivo y en `panel/vendor/LEEME.txt` cuando
corresponde. Los datos se usan solo para mostrar información del emisor; no se
presentan como verdad de negocio ni como base única de decisión.

Generación local: `node scripts/importar-bins.mjs` (lee
`refs/binlist-data-tech/bins.csv`). El archivo `datos/bins.db` es reproducible y
**no** entra en los backups de stock/padrón.

## Otros componentes

- Tabler (@tabler/core y @tabler/icons) — MIT.
- SweetAlert2 — MIT.
- Toastify JS — MIT.
- ApexCharts — MIT.
- Tom Select — Apache-2.0.
- hotkeys-js — MIT.
- banks-db (ramoona) — MIT; revisado como alternativa de color de banco, **no
  usado** porque el repositorio está archivado y no aportaba datos para los BINs
  operativos.
