# PROMPT DE CONTINUIDAD — resolver-ar

Proyecto: dado un DNI, devolver informe con datos REALES del padron de ARCA/AFIP,
usando Faker SOLO para mail y telefono. Leer ~/resolver/CONTEXTO.md.

## COMO CORRER
  node cli.js probar <dni>                      informe + fuentes externas
  node cli.js probar <dni> --offline            sin red
  node cli.js stats                             invariantes del padron
  node cli.js buscar <texto>                    por apellido/nombre
  node server.js                                http://localhost:3001/texto/<dni>
  node importar.js ~/afip/utlfile/padr/*.tmp    reimport (idempotente)

## ESTADO (verificado)
- DB: ~/resolver/datos/padron.db, ruta ABSOLUTA via import.meta.dirname
- 5.664.575 personas fisicas de 6.199.556 lineas
- Invariantes: COUNT(*) = 5.664.575 | cuit duplicados = 0 | dni con mas de un
  cuit = 1.735 | archivo ordenado por CUIT = SI | invalidas = 0 | largos != 51 = 0
- Import idempotente: dos corridas dan exactamente los mismos numeros
- Bugs cerrados: normalizacion de DNI (padding), slice de ACTIVIDAD (49-51),
  rnd() sin sal, BCRA 404 tratado como caida

## FUENTE VERIFICADA (padron)
URL: https://www.afip.gob.ar/genericos/cInscripcion/archivos/apellidoNombreDenominacion.zip
- HTTP 200, 82 MB zip -> 322.376.912 bytes, 6.199.556 registros, latin-1
- Registro de 51 chars + \n => stride 52. Indices 0-based:
  0-10 CUIT | 11-40 denominacion | 41-42 Ganancias | 43-44 IVA |
  45-46 Monotributo | 47 Integrante Soc | 48 Empleador | 49-50 Actividad
  ATENCION: la doc de ARCA (archivoCompleto.asp) lista Actividad en 51/52.
  Es off-by-one. El layout 49-50 es el correcto (confirmado con pyafipws).
- Ordenado por CUIT, 0 CUIT duplicados. Usar If-Modified-Since y tratar 304.

## PREFIJOS
20: 2.745.637 | 27: 2.381.556 | 23: 507.521 | 24: 29.861  -> fisicas
30: 486.030 | 33: 48.746 | 34: 205                     -> juridicas (filtradas)
23/24 no son solo artefacto de DV=10: ANSES asigna prefijo al azar desde 2021.

## DNI / CUIL
- DNI = cuit[2:10], SIEMPRE padded a 8 (normalizarDni())
- CUIL = el CUIT del padron tal cual (REAL_AFIP), prefijos 20/23/24/27
- Fallback solo si el DNI no esta: recalcular el DV. Si da 10, el prefijo pasa a
  23 y se RECALCULA (da 9 para prefijo 20 y 4 para 27). Nunca hardcodear 9.
- 1.735 DNIs con DOS CUITs. ORDER BY determinista + bloque DNI AMBIGUO.
  Caso real: 00421954 -> MENDONCA (prefijo 20) y BARONI (prefijo 27), dos personas.
- La denominacion viene truncada a 30 chars en el origen.

## FUENTES EXTERNAS (lib/fuentes.js, NO BLOQUEANTES)
- BCRA: api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/{cuit}
  FLAPEA (alterna 520 y 200). JSON: results.denominacion, results.periodos[]
  .entidades[] con entidad, situacion (1-6), monto, diasAtrasoPago.
  404 = SIN_DATOS (no esta en la Central), NO es caida.
  timeout 8s, 2 intentos con backoff, tolerante a respuesta no-JSON.
  Trae la denominacion: se cruza contra el padron y se declara si no coincide.
- CNE (domicilio + fecha de nacimiento):
  POST https://www.padron.gov.ar/padron-api/consulta
  Bundle: https://www.padron.gov.ar/consulta-1fa7bd67.js
  Hay /padron-api/captcha.jpg al lado. HOY 503, request sin verificar.
- cuitonline.com/search.php?q=<cuit|nombre> como plan C

## FUENTES DESCARTADAS
- Padron PASO 2021.rar: RAR5 con un solo entry "Totales PASO 2021.xlsx"
  => totales agregados, no per-persona
- padron_2017.zip (electoral.gob.ar): timeout. El sitio no sirve para automatizar
- ARCA REST sr-padron/v2/persona/{cuit}: 404. Alternativa SOAP a4/a5/a13 con certificado

## COBERTURA
5,66M fisicas sobre ~35M electores = ~16%. "No encontrado" es el CASO NORMAL.
PROCEDENCIA REAL_AFIP (del informe) es distinto de COBERTURA POBLACIONAL.

## REGLAS
- No inventar lo que esta en el padron. Cada campo declara fuente.
- El titular se muestra crudo; la denominacion completa se guarda aparte.
- Semilla determinista por DNI (FNV) + sal por campo.
- El informe declara cobertura, ambiguedad, cruce de nombre y estado de fuentes.
- El import aserta invalidas == 0 y separa contadores.

## ENTORNO (macOS, zsh)
- LC_ALL=C para cut | sed -n 'l'. Multilinea: heredoc a archivo + bash
- node:sqlite es experimental en Node 24 (warning normal)
- Rutas ABSOLUTAS para la DB. Nunca relativas al CWD.
- Matar el server anterior antes de relanzar. Puerto 3001.
- lsar (no unar -l) para listar RAR.

## PENDIENTE
1. Verificar el endpoint de la CNE cuando el backend vuelva (domicilio + nacimiento)
2. Reintentar BCRA en un momento de 200 para validar el camino DISPONIBLE
