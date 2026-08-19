import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not set — refusing to start without it.");
}

/** Reads the session cookie, verifies it, and attaches req.user.
 *  Rejects with 401 if missing/invalid/expired. This is the real
 *  authorization boundary — unlike the old app, the SERVER decides
 *  who's logged in, not the browser's own localStorage. */
export function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: "Not authenticated." });

  try {
    req.user = jwt.verify(token, JWT_SECRET); // { userId, role, gymId }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expired or invalid." });
  }
}

/** Use after requireAuth. Blocks anyone whose role isn't in `roles`. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Not authorized." });
    }
    next();
  };
}

export { JWT_SECRET };
