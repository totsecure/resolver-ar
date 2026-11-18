# ARGOS API — Base Local ILIMITADA (texto del proveedor, 2026-11-18)

Guardado verbatim para no depender de la memoria. El endpoint local es GRATIS
(no gasta cupo) y es la unica fuente que sigue viva cuando nos pausan.

---

## Mensaje del proveedor

✅ ARGOS API — Consulta en Base Local (/api/v1/local) Habilitada como ILIMITADA

Te habilitamos el endpoint de Base de Datos Local de forma 100% ILIMITADA (sin
tope por minuto, hora ni día, y sin timeouts) en tus 10 IPs autorizadas
(179.43.134.10 al .14 y 179.43.152.194 al .198).

⚠️ Nota: Los límites de 15 req/min · 100 req/hora · 500 req/día aplican
únicamente a los endpoints externos (RENAPER en vivo, Nosis, IA, etc.). El
endpoint /api/v1/local/<dni> queda totalmente libre e ilimitado.

---

## Documentación técnica

### 1. Endpoint y método

```
GET https://argosbot.info/api/v1/local/{dni}
```

También disponible por IP directa: `http://45.76.3.140:5100/api/v1/local/{dni}`

Nosotros usamos `http://104.234.7.128:5100/api/v1/local/{dni}` (el `ARGOS_BASE`
del `/etc/resolver.env`) y responde.

- Autenticación: automática por las 10 IPs en whitelist (sin headers ni tokens).
- Parámetro: DNI de 7 a 9 dígitos numéricos.
- Límite de velocidad: ILIMITADO.

### 2. Ejemplo de uso (Python)

```python
import requests

dni = "30123456"
r = requests.get(f"https://argosbot.info/api/v1/local/{dni}", timeout=15)

if r.status_code == 200:
    persona = r.json()["data"]
    print(persona["nombre_completo"], persona["cuil"], persona["domicilio"])
elif r.status_code == 404:
    print("DNI no encontrado en base local")
```

### 3. Estructura del JSON de respuesta (200 OK)

```json
{
  "ok": true,
  "fuente": "db_local",
  "dni": "30123456",
  "tokens_descontados": 0,
  "data": {
    "dni": "30123456",
    "nombre_completo": "PEREZ JUAN CARLOS",
    "apellido": "PEREZ",
    "nombre": "JUAN CARLOS",
    "sexo": "M",
    "cuil": "20-30123456-3",
    "fecha_nacimiento": "15/04/1983",
    "edad": 43,
    "fallecido": "NO",
    "domicilio": "AV RIVADAVIA 1234",
    "piso_dpto": "3 B",
    "localidad": "CAPITAL FEDERAL",
    "partido": "CAPITAL FEDERAL",
    "provincia": "CAPITAL FEDERAL",
    "codigo_postal": "C1033AAP",
    "profesion": "EMPLEADO",
    "cobertura_medica": "OSDE",
    "telefonos": ["1145678901"],
    "emails": ["juanperez@gmail.com"],
    "vehiculos": [
      {
        "dominio": "AB123CD",
        "marca": "VOLKSWAGEN",
        "modelo": "GOL TREND 1.6",
        "anio": "2018",
        "porcentaje": "100%"
      }
    ],
    "licencia_conducir": {
      "clases": "B1",
      "vigencia": "2028-04-15",
      "municipio": "CABA"
    },
    "posibles_familiares": [
      {
        "dni": "12345678",
        "nombre": "PEREZ ROBERTO",
        "edad": 71,
        "vinculo": "Posible Padre / Madre"
      }
    ]
  }
}
```

⚠️ **La doc va adelantada respecto de la respuesta real.** Hoy `data` trae:
`correo_electronico, cuil, direccion_actual, dni, domicilios_padron_o_historicos,
edad_actual, fecha_nacimiento, grupo_familiar_detectado, localidad,
nombre_completo, provincia, sexo, signo_zodiacal, telefonos_asociados`.

O sea **`vehiculos`, `licencia_conducir`, `posibles_familiares` y `profesion`
TODAVIA NO VIENEN**. Cuando el proveedor los agregue hay que mapearlos en
`interpretar()` de `lib/argos.js` y mostrarlos en el informe. No inventarlos
antes: diria datos de campos que no existen.

### 4. Códigos HTTP

- `200 OK` — persona encontrada en la base local.
- `400 Bad Request` — formato de DNI inválido.
- `403 Forbidden` — IP fuera de las 10 autorizadas.
- `404 Not Found` — el DNI no registra datos en la base local.

---

## Que hicimos con esto en el codigo

- `pagaCupo(ruta)` + `RUTAS_LIBRES` en `lib/argos.js`: las rutas libres no
  consumen cupo ni pausa anti-scrap. `turno()` y `antiScrap()` salen enseguida.
- `refrescar()` NO saltea `/local` cuando renaper esta castigado (antes si).
- Ruta del server: `GET /local/<dni>?forzar=1`.
- Medido: 64 DNIs frescos en 20s (3.2/s) sin un solo 429 y con el cupo en 0.
  Un `/scoring` completo durante un Nivel 2 baja de 20-45s a 1.8s.

## Reglas de uso

1. **Barrer la base local es gratis**: usarla para precalentar y para buscar
   gente cuando no hay cupo. No gasta nada.
2. **Usarla como respaldo durante un castigo**: es la unica que sigue viva.
3. **No hace falta pausarla**: ni anti-scrap ni espera entre pedidos.
4. Si aparece un 429 en `/local`, entonces el "ilimitado" tiene techo y hay que
   revisar (hoy no paso nunca).
