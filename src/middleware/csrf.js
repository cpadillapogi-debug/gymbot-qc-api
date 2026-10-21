/* ============================================================
   GYMBOT QC API — CSRF HEADER GATE
   Session auth here is an httpOnly cookie, which browsers attach
   automatically to any cross-site request — the classic CSRF hole.
   Closing it without a stateful token: every mutating request (not
   GET/HEAD/OPTIONS) must carry a custom header, "x-gymbot-client".
   A cross-site <form> POST or <img>/fetch-without-JS attack can set a
   browser's cookies along for the ride, but it CANNOT set a custom
   header on a simple request — only same-origin JS (which is exactly
   what the real frontend is) can do that via fetch()'s `headers` option.

   EXEMPT: /public/* (the anonymous widget — see routes/public.js) has
   no session cookie to protect in the first place; gating it here too
   would just break the embeddable widget for no security benefit.
   /health is exempt for the same "nothing to protect" reason.
   ============================================================ */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const EXEMPT_PREFIXES = ["/public/", "/health"];

export function csrfHeaderGate(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (EXEMPT_PREFIXES.some((p) => req.path === p || req.path.startsWith(p))) return next();

  if (!req.get("x-gymbot-client")) {
    return res.status(403).json({ error: "Missing required client header." });
  }
  return next();
}
