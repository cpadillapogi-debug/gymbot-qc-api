/* ============================================================
   GYMBOT QC API — MAINTENANCE MODE
   Platform-wide kill switch backed by the generic PlatformSetting
   key/value table. DEVELOPER sessions always pass through (so a
   Developer can still get in to turn maintenance back off); everyone
   else gets a 503 while it's on. /health is mounted before this gate
   in server.js so uptime checks keep working during maintenance.

   FAILS OPEN on a DB error — a database hiccup should not itself look
   like "the whole platform is in maintenance" to every visitor; the
   specific request that touches the DB will fail on its own anyway.
   ============================================================ */
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";
import { JWT_SECRET } from "./requireAuth.js";

const MAINTENANCE_KEY = "maintenanceMode";

export async function getMaintenanceState() {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: MAINTENANCE_KEY } });
    const value = row?.value || {};
    return { enabled: Boolean(value.enabled), message: value.message || "", updatedAt: row?.updatedAt || null };
  } catch (err) {
    return { enabled: false, message: "", updatedAt: null };
  }
}

export async function setMaintenanceState(enabled, message = "") {
  const value = { enabled: Boolean(enabled), message: String(message || "").slice(0, 500) };
  const row = await prisma.platformSetting.upsert({
    where: { key: MAINTENANCE_KEY },
    update: { value },
    create: { key: MAINTENANCE_KEY, value },
  });
  return { enabled: value.enabled, message: value.message, updatedAt: row.updatedAt };
}

/** Reads the session cookie directly (rather than depending on
 *  requireAuth having already run) so this gate can sit in front of
 *  EVERY route, including ones that don't otherwise require auth. */
function roleFromCookie(req) {
  const token = req.cookies?.session;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET).role;
  } catch (err) {
    return null;
  }
}

export async function maintenanceGate(req, res, next) {
  try {
    const state = await getMaintenanceState();
    if (!state.enabled) return next();
    if (roleFromCookie(req) === "DEVELOPER") return next();
    return res.status(503).json({
      error: state.message || "GymBot QC is temporarily down for maintenance. Please check back shortly.",
      maintenance: true,
    });
  } catch (err) {
    return next(); // fail open — see header comment
  }
}
