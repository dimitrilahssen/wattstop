// Outils navigateur partagés par les tests Playwright : session de l'app et relais réseau derrière un proxy.
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_KEY, BASE_URL, PASSWORD, USERS } from "./lib.mjs";

/** Ouvre une session Supabase et renvoie les cookies que l'app (@supabase/ssr) attend. */
export async function sessionCookies(role) {
  const jar = [];
  const sb = createServerClient(SUPABASE_URL, SUPABASE_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (cs) => cs.forEach((c) => { const i = jar.findIndex((j) => j.name === c.name); i >= 0 ? jar.splice(i, 1, c) : jar.push(c); }),
    },
  });
  const { error } = await sb.auth.signInWithPassword({ email: USERS[role].email, password: PASSWORD });
  if (error) throw error;
  const { hostname } = new URL(BASE_URL);
  return jar.filter((c) => c.value).map((c) => ({ name: c.name, value: c.value, domain: hostname, path: "/", sameSite: "Lax" }));
}

export async function wire(ctx, errors) {
  // Derrière un proxy d'entreprise (HTTPS_PROXY), le navigateur de test passe ses appels Supabase par Node.
  if (process.env.HTTPS_PROXY) {
    await ctx.route(`${SUPABASE_URL}/**`, async (route) => {
      const r = route.request();
      const headers = { ...r.headers() };
      delete headers.host; delete headers["content-length"];
      const res = await fetch(r.url(), { method: r.method(), headers, body: ["GET", "HEAD"].includes(r.method()) ? undefined : r.postDataBuffer() });
      const out = Object.fromEntries(res.headers);
      delete out["content-encoding"]; delete out["content-length"];
      await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
    });
  }
  // Formulaire de carte Stripe : ses scripts et iframes sont relayés de la même façon.
  // Les domaines de mesure d'audience Stripe non autorisés sont simplement coupés.
  if (process.env.HTTPS_PROXY) {
    await ctx.route(/^https:\/\/([a-z0-9-]+\.)*(stripe\.com|stripe\.network|stripecdn\.com)\//, async (route) => {
      const r = route.request();
      try {
        const headers = { ...r.headers() };
        delete headers.host; delete headers["content-length"];
        const res = await fetch(r.url(), { method: r.method(), headers, body: ["GET", "HEAD"].includes(r.method()) ? undefined : r.postDataBuffer() });
        const out = Object.fromEntries(res.headers);
        delete out["content-encoding"]; delete out["content-length"];
        await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
      } catch {
        await route.abort();
      }
    });
  }
  // Idem pour le WebSocket Realtime (notifications en direct) : relayé par Node derrière un proxy
  if (process.env.HTTPS_PROXY) {
    await ctx.routeWebSocket(/\/realtime\/v1\//, (ws) => {
      const up = new WebSocket(ws.url());
      up.binaryType = "arraybuffer";
      const queue = [];
      up.addEventListener("open", () => queue.splice(0).forEach((m) => up.send(m)));
      up.addEventListener("message", (e) => ws.send(typeof e.data === "string" ? e.data : Buffer.from(e.data)));
      up.addEventListener("close", () => ws.close());
      ws.onMessage((m) => (up.readyState === WebSocket.OPEN ? up.send(m) : queue.push(m)));
      ws.onClose(() => up.close());
    });
  }
  // Fond de carte uni : le test ne dépend pas d'un service de tuiles externe.
  await ctx.route("**/tiles.openfreemap.org/**", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#e8ecef" } }] }) })
  );
  ctx.on("page", (p) => {
    p.on("pageerror", (e) => errors.push(`[${p.url()}] ${e.message}`));
    p.on("console", (m) => m.type() === "error" && errors.push(`[${p.url()}] ${m.text()}`));
  });
}
