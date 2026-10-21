const UP = "https://action-early-pants.ngrok-free.dev";
export default {
  async fetch(req) {
    const u = new URL(req.url);
    const h = new Headers(req.headers);
    h.set("ngrok-skip-browser-warning", "1");
    h.set("host", "action-early-pants.ngrok-free.dev");
    const r = await fetch(UP + u.pathname + u.search, {
      method: req.method,
      headers: h,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    });
    const out = new Response(r.body, r);
    out.headers.set("access-control-allow-origin", "*");
    return out;
  },
};
