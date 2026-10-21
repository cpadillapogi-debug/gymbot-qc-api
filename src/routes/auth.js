import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";
import { requireAuth, JWT_SECRET } from "../middleware/requireAuth.js";
import { loginLimiter, registerLimiter, changePasswordLimiter } from "../middleware/rateLimit.js";

const router = Router();
const BCRYPT_ROUNDS = 12;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "");
}

// bcrypt silently truncates anything past 72 BYTES (not characters) —
// without this guard, "correcthorsebatterystaple" + 80 characters of
// junk would hash identically to just the first 72 bytes, which is
// surprising and worth rejecting outright rather than accepting
// something the user didn't actually set.
function exceedsBcryptByteLimit(password) {
  return Buffer.byteLength(password || "", "utf8") > 72;
}

// A fixed, precomputed hash compared against on a nonexistent-user
// login so the request takes roughly the same time either way —
// otherwise "no such user" (fast: no bcrypt.compare) vs "wrong
// password" (slow: one bcrypt.compare) is a timing side-channel that
// lets an attacker enumerate registered emails.
let DUMMY_HASH = null;
async function getDummyHash() {
  if (!DUMMY_HASH) DUMMY_HASH = await bcrypt.hash("gymbot-qc-dummy-timing-guard", BCRYPT_ROUNDS);
  return DUMMY_HASH;
}

// gymId always comes from the real relation (user.gym.id via Gym.ownerId),
// never a scalar column on User — there isn't one anymore.
//
// SameSite: this API and the frontend are deployed as two SEPARATE
// origins (a static host for the frontend, Render for the API), so a
// credentialed fetch() from the frontend is a cross-site request. A
// SameSite=Lax cookie is NOT attached to cross-site fetch()/XHR (only to
// top-level navigations), which would silently break every authenticated
// call in production. SameSite=None is required for that — and browsers
// require Secure (HTTPS-only) whenever SameSite=None is set, which is why
// this is tied to NODE_ENV=production rather than always-on. In local dev
// (NODE_ENV not "production"), Lax over plain HTTP is used instead, since
// SameSite=None without Secure is rejected by modern browsers outright.
function cookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true, // not readable by JS — closes the old "read it out of localStorage" hole
    secure: isProd, // HTTPS only in prod — required whenever sameSite is "none"
    sameSite: isProd ? "none" : "lax",
    maxAge: SESSION_MAX_AGE_MS,
  };
}

function issueSessionCookie(res, user) {
  const token = jwt.sign(
    { userId: user.id, role: user.role, gymId: user.gym?.id ?? null },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
  res.cookie("session", token, cookieOptions());
}

// Strips passwordHash and flattens the joined gym relation into a
// plain gym object + gymId, so the frontend gets a stable shape
// whether or not `gym` was included in the Prisma query.
function toSafeUser(user) {
  const { passwordHash, gym, ...rest } = user;
  return { ...rest, gymId: gym?.id ?? null, gym: gym ?? null };
}

/* ---------- POST /auth/register ---------- */
router.post("/register", registerLimiter, async (req, res) => {
  const { gymName, email, password, confirmPassword } = req.body || {};
  const cleanGymName = (gymName || "").trim();
  const cleanEmail = (email || "").trim().toLowerCase();

  if (!cleanGymName) return res.status(400).json({ error: "Please enter your gym's name." });
  if (!isValidEmail(cleanEmail)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (exceedsBcryptByteLimit(password)) return res.status(400).json({ error: "Password is too long." });
  if (password !== confirmPassword) return res.status(400).json({ error: "Passwords don't match." });

  const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
  if (existing) return res.status(409).json({ error: "An account with that email already exists." });

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      email: cleanEmail,
      passwordHash,
      role: "GYM_OWNER",
      gym: { create: { name: cleanGymName } },
    },
    include: { gym: true },
  });

  issueSessionCookie(res, user);
  res.status(201).json({ ok: true, user: toSafeUser(user) });
});

/* ---------- POST /auth/login ---------- */
router.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = (email || "").trim().toLowerCase();

  // Same generic error for "no such user" and "wrong password" —
  // don't leak which one it was.
  const genericError = { error: "Incorrect email or password." };

  if (!isValidEmail(cleanEmail) || !password) return res.status(400).json(genericError);

  const user = await prisma.user.findUnique({
    where: { email: cleanEmail },
    include: { gym: true },
  });
  if (!user) {
    await bcrypt.compare(password, await getDummyHash()); // timing guard — see getDummyHash()
    return res.status(401).json(genericError);
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json(genericError);

  if (user.role === "GYM_OWNER" && user.gym?.deletedAt) {
    return res.status(403).json({
      error: "This gym account has been deactivated. Contact support if you believe this is a mistake.",
    });
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  issueSessionCookie(res, user);
  res.json({ ok: true, user: toSafeUser(user) });
});

/* ---------- POST /auth/logout ---------- */
router.post("/logout", (req, res) => {
  // clearCookie must be called with matching attributes (sameSite/secure)
  // to the ones the cookie was originally set with, or some browsers
  // won't actually clear it.
  res.clearCookie("session", cookieOptions());
  res.json({ ok: true });
});

/* ---------- POST /auth/change-password ---------- */
router.post("/change-password", requireAuth, changePasswordLimiter, async (req, res) => {
  const { currentPassword, newPassword, confirmNewPassword } = req.body || {};

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }
  if (exceedsBcryptByteLimit(newPassword)) {
    return res.status(400).json({ error: "New password is too long." });
  }
  if (newPassword !== confirmNewPassword) {
    return res.status(400).json({ error: "New passwords don't match." });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user) return res.status(404).json({ error: "User not found." });

  const valid = await bcrypt.compare(currentPassword || "", user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Current password is incorrect." });

  const sameAsCurrent = await bcrypt.compare(newPassword, user.passwordHash);
  if (sameAsCurrent) {
    return res.status(400).json({ error: "New password must be different from your current password." });
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash },
    include: { gym: true },
  });

  await prisma.auditLogEntry.create({
    data: {
      action: "change_password",
      gymId: updated.gym?.id || null,
      performedById: user.id,
      note: "Password changed by the account holder.",
    },
  });

  // Re-issue the session cookie so an in-progress session keeps working
  // seamlessly after the change (same cookie shape as login/register).
  issueSessionCookie(res, updated);
  res.json({ ok: true, message: "Password changed." });
});

/* ---------- GET /auth/me ---------- */
router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    include: { gym: true },
  });
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json({ user: toSafeUser(user) });
});

export default router;
