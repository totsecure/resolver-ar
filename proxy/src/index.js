/* Worker de resolver-ar.
 *
 * - Valida RESOLVER_TOKEN EN EL WORKER: sin token => 401, no llega a ngrok.
 * - Al upstream manda Authorization: Basic (credenciales de ngrok), no el token.
 * - /gh/<path> lee el repo privado desde raw.githubusercontent.com con GH_TOKEN
 *   y devuelve el texto crudo (también exige RESOLVER_TOKEN).
 *
 * Secrets: RESOLVER_TOKEN, NGROK_USER, NGROK_PASS, GH_TOKEN.
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

async function proxyGh(env, u) {
  if (!env.GH_TOKEN) {
    return new Response("ERROR: falta GH_TOKEN en el Worker\n", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  let ruta;
  try {
    ruta = decodeURIComponent(u.pathname.replace(/^\/gh\/?/, ""));
  } catch (_) {
    return new Response("ERROR: path invalido\n", { status: 400 });
  }
  if (!ruta || ruta.includes("..") || ruta.startsWith("/")) {
    return new Response("ERROR: path invalido\n", { status: 400 });
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
    if (!token || !igualSeguro(token, env.RESOLVER_TOKEN)) return sinAutorizacion();

    if (u.pathname === "/gh" || u.pathname.startsWith("/gh/")) {
      return proxyGh(env, u);
    }

    const arriba = new URL(UP + u.pathname + u.search);
    arriba.searchParams.set("token", token);

    const h = new Headers(req.headers);
    h.delete("authorization");
    h.set("ngrok-skip-browser-warning", "1");
    h.set("host", new URL(UP).host);
    if (env.NGROK_USER && env.NGROK_PASS) {
      h.set("authorization", "Basic " + btoa(`${env.NGROK_USER}:${env.NGROK_PASS}`));
    }

    const r = await fetch(arriba.toString(), {
      method: req.method,
      headers: h,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    });
    const out = new Response(r.body, r);
    out.headers.set("access-control-allow-origin", "*");
    out.headers.set("cache-control", "no-store");
    return out;
  },
};
