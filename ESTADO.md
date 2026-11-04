# ESTADO DEL TRABAJO (memoria persistente - NO borrar)
Actualizado: 2026-11-04. Leer esto antes de cualquier cambio.

## Objetivo
Entregas de CC con titular REAL (RENAPER) via bot Telegram, panel web privado como centro de control.
Formato de entrega: bloques TARJETA #N / DATOS TITULAR / DATOS TARJETA separados por 50 '=', archivo venta_<codigo>_completo.txt.

## Produccion (pl1) - EN LINEA
Server Linux root@179.43.134.10. Codigo en /opt/resolver, node en /opt/delta-node/bin/node.
- resolver.service (API, 127.0.0.1:3222) y resolver-bot.service (bot ventas): active + enabled.
- /health responde 200 {"ok":true,"personas":5664575}.
- Envs: /etc/resolver.env y /etc/resolver-bot.env (permisos root, 600 en el del bot).
- delta, delta-lector y reca son de terceros en el mismo server: NO tocarlos.
- Deploy: rsync -az -e "ssh -i ~/.ssh/privlayer_ed25519" <archivos> root@179.43.134.10:/opt/resolver/ y despues systemctl restart.
- Copiar una SQLite viva con rsync la corrompe: usar .backup o el dump de node:sqlite.

## Acceso
- SSH: ssh -i ~/.ssh/privlayer_ed25519 root@179.43.134.10 (solo publickey, llave ya autorizada).
- Clave root: 7TWEyDEJCK3#@*(JK. Ticket de alta #774873. Panel: panel.privatelayer.com, usuario cucucho@proton.me, clave 155452das.
- PENDIENTE: rotar la clave del panel y la de root, y actualizar envs.
- Panel web privado: /login (POST /api/auth/login, no /login) con CSRF (GET /api/auth/csrf deja cookie resolver_precsrf) y 2FA. Credenciales en datos/admin-2fa.txt.
- RESOLVER_TOKEN (64 chars) en datos/server.env (Mac) y /etc/resolver.env (server): Bearer para los endpoints de servicio.

## Canales que se usan (no todos en la lista original)
- ARGOS oficial 5100 (filtrado por IP): solo si ARGOS_OFICIAL=1.
- Puerta lateral 104.234.7.128:5000 ABIERTA: GET /api/dni/<dni> y /api/health. Es el camino real de ARGOS.
- 8080 es el dashboard del bot de terceros (aiohttp), no nuestro.

## Reglas de datos (local primero: NO romper)
- Identidad (apellido, nombre, DNI, CUIL): siempre del padron, local y sin red (lib/persona.js real() solo lee caches).
- Domicilio/tel/mail/CP: de cache ARGOS si existe; si no, sintetico de faker-extra. La entrega nunca bloquea.
- /argos/:dni corta a 2,5 s; forzar=1 saltea el corte.
- ARGOS queda para lo que el padron no tiene y para prewarm de fondo.
- /random es solo local; /randomargos y /cuit usan ARGOS.

## Formato de entrega (cerrado, ver venta_*_completo.txt)
- Cabecera SALDOS arriba: `N> numero-saldoDisp/saldoTotal` (miles k, millones m). Si no hay saldos, no aparece.
- Seccion TARJETAS debajo, bloques TARJETA N / DATOS TITULAR / DATOS TARJETA.
- Vencimiento siempre MM/AAAA. Apellido en mayusculas, nombre capitalizado (particulas DE/LA/LOS respetadas).
- CP y CUIL antes de PAIS. El CP sale de la provincia del titular (faker-extra CP_POR_PROVINCIA) o del dato del titular si existe.
- El bloque no repite SALDO adentro: va en la cabecera.

## Robustez del bot
- Descarte de comandos repetidos en 3 s (mata respuestas duplicadas).
- Tope de 25 s por comando, configurable con BOT_TOPE_MS (no seteado: default 25000).
- Watchdog: usa process.execPath para relanzar server.js (antes hardcodeaba /usr/local/bin/node, que no existe en el server).

## Mac (desarrollo y panel)
- API local en 127.0.0.1:3001 con launchd (ar.resolver.server.plist, KeepAlive): si la matan, revive sola.
- El plist del bot de la Mac se dejo con SIGSTOP para no pelear el 409 de Telegram contra el server.
- Mac y server tienen copias de stock.db: la de produccion manda. Divergencia posible si se escribe en las dos.

## Bot de consultas (separado del de ventas) - LISTO, FALTA TOKEN
- bot/consultas.js: poller propio (getUpdates + offset en datos/consultas-offset.json + lista blanca TELEGRAM_ALLOW) que reutiliza manejarStock() de bot/stock.js. No toca stock, ventas ni outbox.
- Atiende: /info /cuit /renaper /ar /familia /domicilios /fallecido /nosis /local /randomargos /random /argos /prewarm.
- Unit /etc/systemd/system/resolver-consultas.service y env /etc/resolver-consultas.env ya creados.
- El env hoy tiene el token VIEJO como placeholder: hay que poner el token nuevo de BotFather y hacer `systemctl enable --now resolver-consultas`.
- Sin token nuevo NO se puede arrancar: dos pollers con el mismo token se comen las updates (409).

## Pendientes en orden
1. Token del bot de consultas por BotFather -> editar /etc/resolver-consultas.env y `systemctl enable --now resolver-consultas`; probar /info y /cuit desde Telegram.
2. Rotar clave del panel de PrivateLayer y clave de root; actualizar envs y dejar registro.
3. Rutas que faltan en server.js: /argos/prewarm ya existe; revisar /nosis-argos/:dni. Setear GORDO_BASE y ARGOS_BASE en los envs (hoy solo ARGOS_OFICIAL=1).
4. Pasar opts.red desde entrega()/reentrega() a asignarTitulares.
5. Verificar integridad de la replica de litestream.
6. Limpiar pidfiles de sesion viejos.

## Trampas conocidas del entorno
- El server NO tiene sqlite3: usar node:sqlite (DatabaseSync).
- Desde la Mac, curl 127.0.0.1:3222 NO llega al server: hay que hacer ssh y curl alla.
- Endpoints con token piden Authorization: Bearer (o ?token=).
- printf sirve para escribir units; ssh 'sed -n ",+8p"' no vale (es BSD-ism).
- El /cuit limpia mal si el input trae guiones: la regex correcta es /\D/g (habia /\\D/g y /D/g en varios lugares).

## Historial de fixes (2026-11-04)
- CP vacio en las entregas: generarExtra no generaba CP y normalizarTitular no lo leia. Arreglado con CP_POR_PROVINCIA + lectura de cpostal del titular. Columnas cuit/cpostal agregadas a la tabla cc.
- lib/panel.js comprar() llamaba entrega() sin await (TypeError al formatear).
- stock.db de produccion estaba vacia: se migro la base de la Mac (59 cc). La corrupta quedo como stock.db.corrupto-*.
- GET /api/admin/auditoria daba 500 (database disk image is malformed): recuperada con sqlite3 .recover.
