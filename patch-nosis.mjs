import fs from 'node:fs';
const P = 'proxy/src/index.js';
const src = fs.readFileSync(P, 'utf8');
const ini = src.indexOf('async function proxyNosis(u) {');
const fin = src.indexOf('export default {');
if (ini < 0 || fin < 0 || fin < ini) { console.error('NO ENCONTRE LOS MARCADORES'); process.exit(1); }
const nueva = `async function proxyNosis(u) {
  const destino = u.searchParams.get("u") || "";
  let target = null;
  try { target = new URL(destino); } catch (_) { target = null; }
  const cab = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
  if (!target) return new Response("ERROR: falta u=<url>\\n", { status: 400, headers: cab });
  if (!/(^|\\.)nosis\\.com$/i.test(target.hostname)) {
    return new Response("ERROR: host no permitido: " + target.hostname + "\\n", { status: 400, headers: cab });
  }

  const metodo = (u.searchParams.get("m") || "GET").toUpperCase();
  const conCuerpo = metodo !== "GET" && metodo !== "HEAD";
  const manual = u.searchParams.get("r") === "manual";
  const cookie = u.searchParams.get("cookie") || "";
  let extra = {};
  const hh = u.searchParams.get("h");
  if (hh) { try { extra = JSON.parse(hh); } catch (_) { extra = {}; } }

  const headers = {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "accept-language": "es-AR,es;q=0.9",
    ...(conCuerpo ? { "content-type": u.searchParams.get("ct") || "application/x-www-form-urlencoded" } : {}),
    ...(cookie ? { cookie } : {}),
    ...extra,
  };

  const r = await fetch(target.toString(), {
    method: metodo,
    headers,
    body: conCuerpo ? (u.searchParams.get("b") || "") : undefined,
    redirect: manual ? "manual" : "follow",
  });
  const texto = await r.text();
  const loc = r.headers.get("location") || "";
  const sc = r.headers.get("set-cookie") || "";
  return new Response(texto, {
    status: r.status,
    headers: {
      "content-type": r.headers.get("content-type") || "text/html; charset=utf-8",
      "x-destino": target.toString(),
      "x-final": r.url || "",
      ...(loc ? { "x-location": loc } : {}),
      ...(sc ? { "x-set-cookie": sc } : {}),
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

`;
fs.writeFileSync(P, src.slice(0, ini) + nueva + src.slice(fin));
console.log('parcheado. bytes antes=' + src.length + ' despues=' + fs.statSync(P).size);
