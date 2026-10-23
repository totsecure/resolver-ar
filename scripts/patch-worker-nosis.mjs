import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const P = '/Users/bunker/resolver/proxy/src/index.js';
let s = fs.readFileSync(P, 'utf8');

if (s.includes('proxyNosis')) { console.log('ya estaba'); process.exit(0); }

const FUNCION = `/* /nosis?u=<url-encoded>&m=GET|POST&b=<cuerpo>
 * Trae una URL de Nosis desde la red de Cloudflare (el Mac no la alcanza).
 * Solo permite el host nosis.com para no quedar como proxy abierto. */
async function proxyNosis(u) {
  const destino = u.searchParams.get("u") || "";
  let target = null;
  try { target = new URL(destino); } catch (_) { target = null; }
  const cab = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
  if (!target) return new Response("ERROR: falta u=<url>\\n", { status: 400, headers: cab });
  if (!/(^|\\.)nosis\\.com$/i.test(target.hostname)) {
    return new Response("ERROR: host no permitido: " + target.hostname + "\\n", { status: 400, headers: cab });
  }

  const metodo = (u.searchParams.get("m") || "GET").toUpperCase();
  const conCuerpo = metodo !== "GET" && metodo !== "HEAD";
  const r = await fetch(target.toString(), {
    method: metodo,
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "es-AR,es;q=0.9",
      ...(conCuerpo ? { "content-type": u.searchParams.get("ct") || "application/x-www-form-urlencoded" } : {}),
    },
    body: conCuerpo ? (u.searchParams.get("b") || "") : undefined,
  });
  const texto = await r.text();
  return new Response(texto, {
    status: r.status,
    headers: {
      "content-type": r.headers.get("content-type") || "text/html; charset=utf-8",
      "x-destino": target.toString(),
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

export default {`;

const RUTA = `    if (u.pathname === "/gh" || u.pathname.startsWith("/gh/")) {
      return proxyGh(env, u);
    }
    if (u.pathname === "/nosis") {
      return proxyNosis(u);
    }`;

s = s.replace('export default {', FUNCION);
s = s.replace(`    if (u.pathname === "/gh" || u.pathname.startsWith("/gh/")) {
      return proxyGh(env, u);
    }`, RUTA);

fs.writeFileSync(P, s);
console.log('worker parcheado con /nosis');

try { execFileSync('node', ['--check', P], { stdio: 'inherit' }); console.log('node --check: OK'); }
catch (e) { console.log('node --check: FALLO'); process.exit(1); }
