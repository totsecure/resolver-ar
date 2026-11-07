#!/bin/bash
# Espera a que termine el lote de ARGOS, rescata los falsos errores por rate
# limit (que igual trajeron dato), regenera el Excel y lo deja listo.
#   setsid nohup /opt/resolver/scripts/cerrar.sh > /opt/resolver/datos/cerrar.log 2>&1 &
NODE=/opt/delta-node/bin/node
cd /opt/resolver || exit 1

echo "[$(date +%H:%M:%S)] esperando a que se vacie la cola de pendientes..."

while true; do
  # sigue el proceso de consulta vivo?
  if ! pgrep -f "argos-cuil.mjs" > /dev/null; then
    pend=$($NODE -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/opt/resolver/datos/cuil.db",{readOnly:true});console.log(d.prepare("SELECT COUNT(*) n FROM persona WHERE estado=\x27pendiente\x27").get().n)' 2>/dev/null)
    echo "[$(date +%H:%M:%S)] proceso terminado. pendientes=$pend"
    # si quedaron pendientes y nadie consulta, vuelve a lanzar
    if [ "$pend" != "0" ]; then
      echo "[$(date +%H:%M:%S)] relanzo la consulta de los $pend que quedaron"
      setsid nohup $NODE scripts/argos-cuil.mjs /opt/resolver/datos/cuil-combinado.txt /opt/resolver/datos/cuil-final.csv \
        >> /opt/resolver/datos/cuil-lote.log 2>&1 < /dev/null &
      sleep 60
      continue
    fi
    break
  fi
  sleep 60
done

echo "[$(date +%H:%M:%S)] rescatando errores que igual trajeron mail o telefono"
$NODE -e '
const {DatabaseSync} = require("node:sqlite");
const d = new DatabaseSync("/opt/resolver/datos/cuil.db");
const r = d.prepare("UPDATE persona SET estado=\x27ok\x27, motivo=\x27ok (rescatado)\x27 WHERE estado=\x27error\x27 AND (mail != \x27\x27 OR tels != \x27\x27)").run();
console.log("rescatados:", r.changes);
const q = (s) => d.prepare(s).get().n;
console.log(JSON.stringify({
  ok: q("SELECT COUNT(*) n FROM persona WHERE estado=\x27ok\x27"),
  err: q("SELECT COUNT(*) n FROM persona WHERE estado=\x27error\x27"),
  mail: q("SELECT COUNT(*) n FROM persona WHERE mail != \x27\x27"),
  tel: q("SELECT COUNT(*) n FROM persona WHERE tels != \x27\x27"),
}));
d.close();
' 2>/dev/null

echo "[$(date +%H:%M:%S)] generando el Excel final"
$NODE scripts/facturas-excel.mjs /opt/resolver/datos/facturas/clientes-argos.xlsx 2>&1 | grep -v -e Experimental -e trace
echo "[$(date +%H:%M:%S)] LISTO -> /opt/resolver/datos/facturas/clientes-argos.xlsx"
