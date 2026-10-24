/* Worker de resolver-ar.
 *
 * - Valida RESOLVER_TOKEN EN EL WORKER: sin token => 401, no llega a ngrok.
 * - Al upstream manda Authorization: Basic (credenciales de ngrok), no el token.
 * - /gh/<path> lee el repo privado desde un snapshot en KV (binding REPO),
 *   cargado con scripts/worker-repo.mjs. Si la clave no esta en KV y existe
 *   GH_TOKEN, cae a raw.githubusercontent.com (fallback opcional).
 * - /nosis  : passthrough solo a *.nosis.com.
 * - /proxy  : mismo contrato, allowlist de fuentes publicas (*.gob.ar,
 *   *.msal.gov.ar, cuitonline.com, binlist.net, bincheck.io, dateas, nosis).
 *
 * Secrets: RESOLVER_TOKEN, NGROK_USER, NGROK_PASS. GH_TOKEN es opcional.
 */

const UP = "https://action-early-pants.ngrok-free.dev";
const GH_REPO = "cucucho-svg/resolver-ar";
const GH_BRANCH = "main";

function tokenDe(req, url) {
  const h = req.headers.get("authorization") || "";
  const bearer = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  return bearer || url.searchParams.get("token") || "";
}

/* Comparacion de longitud constante (suficiente para un token de 32 bytes). */
function igualSeguro(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let dif = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) dif |= (x[i] || 0) ^ (y[i] || 0);
  return dif === 0;
}

function sinAutorizacion() {
  return new Response(JSON.stringify({
    error: "no autorizado",
    detalle: "usar Authorization: Bearer <token> o ?token=<token>",
  }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

/* /gh/<path> — snapshot privado del repo dentro del Worker.
 *
 * Prioridad: KV (binding REPO, cargado por scripts/worker-repo.mjs) y, si esa
 * clave no existe, GitHub con GH_TOKEN (fallback opcional). Asi no hace falta
 * un PAT de GitHub para leer el repo: el snapshot se sube con wrangler, que
 * solo habla con Cloudflare y no identifica a nadie en GitHub.
 */
async function proxyGh(env, u) {
  let ruta;
  try {
    ruta = decodeURIComponent(u.pathname.replace(/^\/gh\/?/, ""));
  } catch (_) {
    return new Response("ERROR: path invalido\n", { status: 400 });
  }
  if (!ruta || ruta.includes("..") || ruta.startsWith("/")) {
    return new Response("ERROR: path invalido\n", { status: 400 });
  }

  if (env.REPO) {
    const valor = await env.REPO.get(ruta);
    if (valor !== null) {
      return new Response(valor, {
        status: 200,
        headers: {
          "content-type": tipoDe(ruta),
          "x-origen": "kv",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        },
      });
    }
  }

  if (!env.GH_TOKEN) {
    return new Response("ERROR: no encontrado en el snapshot (/gh/" + ruta + ")\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const r = await fetch(
    `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${ruta}`,
    {
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        "user-agent": "resolver-ar-worker",
        accept: "text/plain, */*",
      },
    }
  );
  const cuerpo = await r.text();
  return new Response(cuerpo, {
    status: r.status,
    headers: {
      "content-type": r.headers.get("content-type") || "text/plain; charset=utf-8",
      "x-origen": "github",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

function tipoDe(ruta) {
  const ext = String(ruta).toLowerCase().split(".").pop();
  const tipos = {
    json: "application/json; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    ts: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    sh: "text/plain; charset=utf-8",
    toml: "text/plain; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    sql: "text/plain; charset=utf-8",
    svg: "image/svg+xml",
  };
  return tipos[ext] || "text/plain; charset=utf-8";
}

/* Allowlists del proxy.
 * /nosis queda EXACTAMENTE igual (solo nosis.com, compatibilidad).
 * /proxy es la ruta nueva para fuentes publicas. */
const HOSTS_NOSIS = [/(^|\.)nosis\.com$/i];
const HOSTS_PROXY = [
  /(^|\.)gob\.ar$/i,
  /(^|\.)msal\.gov\.ar$/i,
  /(^|\.)cuitonline\.com$/i,
  /(^|\.)binlist\.net$/i,
  /(^|\.)bincheck\.io$/i,
  /(^|\.)dateas\.com$/i,
  /(^|\.)dateas\.com\.ar$/i,
  /(^|\.)apistore\.pcnt\.io$/i,
  /(^|\.)nosis\.com$/i,
];
const hostPermitido = (host, lista) => lista.some((re) => re.test(host));

/* /nosis?u=<url-encoded>&m=GET|POST&b=<cuerpo>
 * Trae una URL de Nosis desde la red de Cloudflare (el Mac no la alcanza).
 * /proxy usa el mismo contrato con allowlist ampliada. */
async function proxyGenerico(u, lista) {
  const destino = u.searchParams.get("u") || "";
  let target = null;
  try { target = new URL(destino); } catch (_) { target = null; }
  const cab = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
  if (!target) return new Response("ERROR: falta u=<url>\n", { status: 400, headers: cab });
  if (!hostPermitido(target.hostname, lista)) {
    return new Response("ERROR: host no permitido: " + target.hostname + "\n", { status: 400, headers: cab });
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
  /* OJO: headers.get("set-cookie") une varias cookies con ", " y las fechas
   * "Expires=Wed, 22 Oct..." tienen coma. getSetCookie() las devuelve enteras.
   * Mandamos el array en x-set-cookie-json (fuente de verdad para el cliente)
   * y dejamos x-set-cookie por compatibilidad. */
  let cookies = [];
  if (typeof r.headers.getSetCookie === "function") {
    cookies = r.headers.getSetCookie();
  } else {
    const una = r.headers.get("set-cookie") || "";
    if (una) cookies = [una];
  }
  return new Response(texto, {
    status: r.status,
    headers: {
      "content-type": r.headers.get("content-type") || "text/html; charset=utf-8",
      "x-destino": target.toString(),
      "x-final": r.url || "",
      ...(loc ? { "x-location": loc } : {}),
      ...(cookies.length ? { "x-set-cookie": cookies.join(", "), "x-set-cookie-json": JSON.stringify(cookies) } : {}),
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
        },
      });
    }

    if (!env.RESOLVER_TOKEN) {
      return new Response("ERROR: falta RESOLVER_TOKEN en el Worker\n", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const token = tokenDe(req, u);
    const gated = u.pathname === "/gh" || u.pathname.startsWith("/gh/"); if (gated && (!token || !igualSeguro(token, env.RESOLVER_TOKEN))) return sinAutorizacion();

    if (u.pathname === "/gh" || u.pathname.startsWith("/gh/")) {
      return proxyGh(env, u);
    }
    if (u.pathname === "/nosis") {
      return proxyGenerico(u, HOSTS_NOSIS);
    }
    if (u.pathname === "/proxy") {
      return proxyGenerico(u, HOSTS_PROXY);
    }

    const arriba = new URL(UP + u.pathname + u.search);
    if (token) arriba.searchParams.set("token", token);

    const h = new Headers(req.headers);
    h.delete("authorization");
    h.delete("x-forwarded-for");
    h.delete("x-real-ip");
    const ipCliente = req.headers.get("cf-connecting-ip");
    if (ipCliente) {
      h.set("x-forwarded-for", ipCliente);
      h.set("x-real-ip", ipCliente);
    }
    h.set("ngrok-skip-browser-warning", "1");
    h.set("host", new URL(UP).host);
    if (env.NGROK_USER && env.NGROK_PASS) {
      h.set("authorization", "Basic " + btoa(`${env.NGROK_USER}:${env.NGROK_PASS}`));
    }

    const idempotente = req.method === "GET" || req.method === "HEAD";
    const opciones = {
      method: req.method,
      headers: h,
      body: idempotente ? undefined : req.body,
    };
    /* ngrok free reconecta de vez en cuando y devuelve 404/5xx transitorio:
     * reintentamos una o dos veces para que el usuario no vea la "caída". */
    let r;
    const intentos = idempotente ? 3 : 1;
    for (let i = 0; i < intentos; i++) {
      try {
        r = await fetch(arriba.toString(), opciones);
        if (r.status !== 404 && r.status < 500) break;
        if (i < intentos - 1) await new Promise((res) => setTimeout(res, 300 * (i + 1)));
      } catch (e) {
        if (i === intentos - 1) throw e;
        await new Promise((res) => setTimeout(res, 300 * (i + 1)));
      }
    }
    const out = new Response(r.body, r);
    out.headers.set("access-control-allow-origin", "*");
    out.headers.set("cache-control", "no-store");
    return out;
  },
};
