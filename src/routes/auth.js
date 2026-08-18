import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";
import { requireAuth, JWT_SECRET } from "../middleware/requireAuth.js";

const router = Router();
const BCRYPT_ROUNDS = 12;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "");
}

// gymId always comes from the real relation (user.gym.id via Gym.ownerId),
// never a scalar column on User — there isn't one anymore.
function issueSessionCookie(res, user) {
  const token = jwt.sign(
    { userId: user.id, role: user.role, gymId: user.gym?.id ?? null },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
  res.cookie("session", token, {
    httpOnly: true, // not readable by JS — closes the old "read it out of localStorage" hole
    secure: process.env.NODE_ENV === "production", // HTTPS only in prod
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_MS,
  });
}

// Strips passwordHash and flattens the joined gym relation into a
// plain gym object + gymId, so the frontend gets a stable shape
// whether or not `gym` was included in the Prisma query.
function toSafeUser(user) {
  const { passwordHash, gym, ...rest } = user;
  return { ...rest, gymId: gym?.id ?? null, gym: gym ?? null };
}

/* ---------- POST /auth/register ---------- */
router.post("/register", async (req, res) => {
  const { gymName, email, password, confirmPassword } = req.body || {};
  const cleanGymName = (gymName || "").trim();
  const cleanEmail = (email || "").trim().toLowerCase();

  if (!cleanGymName) return res.status(400).json({ error: "Please enter your gym's name." });
  if (!isValidEmail(cleanEmail)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
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
router.post("/login", async (req, res) => {
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
  if (!user) return res.status(401).json(genericError);

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
  res.clearCookie("session");
  res.json({ ok: true });
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
