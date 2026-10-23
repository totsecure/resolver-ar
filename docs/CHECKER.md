# Checker — contrato para enchufar un proveedor

El checker es un hook único en `lib/checker.js`. La cola y los resultados viven
en `stock.db`; nunca se guarda el PAN completo en `checker_resultados` ni en logs.

## Interfaz

```js
checker.registrarProveedor('mi-proveedor', async (cc) => {
  // cc: fila de cc (numero, bin, mes, anio, cvv, dni, ...)
  return {
    estado: 'ok' | 'falla' | 'pendiente' | 'error',
    motivo: 'texto corto opcional',
    proveedor: 'mi-proveedor',
  };
});
```

- `ok` / `falla` actualizan `cc.verif_estado`.
- `pendiente` deja la tarjeta para revisión manual del admin.
- `error` registra el intento y no cambia el estado.
- Un proveedor que lanza excepción se normaliza a `error`.
- El nombre se elige por `CHECKER_PROVEEDOR` en `datos/server.env`; `manual`
  es el default y no decide automáticamente.

## Proveedores incluidos

- `manual`: deja pendiente; el admin marca OK/falla con motivo.
- `prueba`: determinístico y sin red. Números terminados en dígito par → `ok`;
  impar → `falla`. Sirve para probar el hook y la cola.

## Uso

Bot vinculado: `/chk <codigo|grupo>`.
Web: botón **Verificar** en cada reserva del catálogo.
Admin: pestaña **Checker** para encolar un lote, procesar y marcar manualmente.
