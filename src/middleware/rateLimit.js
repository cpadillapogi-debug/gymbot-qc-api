/* ============================================================
   GYMBOT QC — RATE LIMITING (auth endpoints)
   Closes the brute-force gap flagged in the production checklist:
   before this, nothing stopped an attacker from throwing unlimited
   password guesses at /auth/login.

   LIMITATION — BE HONEST ABOUT THIS: express-rate-limit's default
   store is IN-MEMORY, per server process. That means:
     1. Limits reset if the server restarts.
     2. If you ever run more than one server instance/dyno behind a
        load balancer, each instance tracks its own counts — an
        attacker spread across instances gets multiplied headroom
        (e.g. 2 instances = effectively 2x the limit below).
   For a single-instance deployment (fine for the first gyms), this
   is a real, meaningful protection. Before scaling horizontally,
   swap the store for a shared one (e.g. rate-limit-redis) — see
   https://express-rate-limit.mintlify.app/reference/stores for how.
   ============================================================ */
import rateLimit from "express-rate-limit";

// Generic response so a rate-limited request looks like any other
// failure to an attacker's script — no "you've been rate limited,
// try again in Xs" fingerprinting beyond what the 429 status itself
// already reveals.
function tooManyRequestsHandler(req, res) {
  res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." });
}

/** Strict: login is the actual brute-force target (guessing an
 *  existing account's password). 10 attempts / 15 minutes per IP —
 *  generous enough for a real user who fat-fingers their password a
 *  few times, tight enough to make password-guessing impractical. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequestsHandler,
  // Successful logins don't count against the window, so a real user
  // who got their password right on attempt 3 isn't penalized later
  // for those 2 earlier typos.
  skipSuccessfulRequests: true,
});

/** Looser: registration isn't a credential-guessing target the same
 *  way, but deserves its own limit against automated spam-account
 *  creation. 20 / hour per IP. */
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequestsHandler,
});
