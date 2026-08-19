import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";

const router = Router();

// Every route below requires a logged-in DEVELOPER. requireAuth checks
// the session cookie is valid; requireRole checks the role on THAT
// verified session — never trust a role passed in from the client.
router.use(requireAuth, requireRole("DEVELOPER"));

function toSafeUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

/* ---------- GET /admin/users ---------- */
// Every user on the platform, passwordHash stripped. Backs
// getAllUsersForDeveloper() in the frontend.
router.get("/users", async (req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "desc" } });
  res.json({ users: users.map(toSafeUser) });
});

/* ---------- GET /admin/users/:id ---------- */
// Backs getUserByIdForDeveloper().
router.get("/users/:id", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json({ user: toSafeUser(user) });
});

/* ---------- GET /admin/gyms ---------- */
// Every gym on the platform (including soft-deleted ones, same as the
// old getAllGymsForDeveloper()), with owner joined in.
router.get("/gyms", async (req, res) => {
  const gyms = await prisma.gym.findMany({
    include: { owner: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({
    gyms: gyms.map((gym) => ({
      id: gym.id,
      name: gym.name,
      ownerId: gym.ownerId,
      createdAt: gym.createdAt,
      deletedAt: gym.deletedAt,
      owner: gym.owner ? toSafeUser(gym.owner) : null,
    })),
  });
});

/* ---------- POST /admin/gyms/:id/delete (soft delete) ---------- */
router.post("/gyms/:id/delete", async (req, res) => {
  const gym = await prisma.gym.findUnique({ where: { id: req.params.id } });
  if (!gym) return res.status(404).json({ error: "Gym not found." });
  if (gym.deletedAt) return res.status(409).json({ error: "This gym is already deleted." });

  const updated = await prisma.gym.update({
    where: { id: gym.id },
    data: { deletedAt: new Date() },
  });

  await prisma.auditLogEntry.create({
    data: {
      action: "DELETE",
      gymId: gym.id,
      performedById: req.user.userId,
      previousValue: null,
      newValue: updated.deletedAt.toISOString(),
      note: "Soft delete — no leads/settings/conversations/invoices/subscription/analytics were removed.",
    },
  });

  res.json({ ok: true, message: `${gym.name} was deleted. This can be restored at any time.` });
});

/* ---------- POST /admin/gyms/:id/restore ---------- */
router.post("/gyms/:id/restore", async (req, res) => {
  const gym = await prisma.gym.findUnique({ where: { id: req.params.id } });
  if (!gym) return res.status(404).json({ error: "Gym not found." });
  if (!gym.deletedAt) return res.status(409).json({ error: "This gym isn't deleted." });

  await prisma.gym.update({ where: { id: gym.id }, data: { deletedAt: null } });

  await prisma.auditLogEntry.create({
    data: {
      action: "RESTORE",
      gymId: gym.id,
      performedById: req.user.userId,
      previousValue: gym.deletedAt.toISOString(),
      newValue: null,
      note: "Gym account restored from a soft delete.",
    },
  });

  res.json({ ok: true, message: `${gym.name} was restored.` });
});

/* ---------- POST /admin/users/:id/reset-password ----------
   Still a placeholder — there's no email delivery wired up yet.
   Logs the request to the audit log so there's a real record, same
   honesty as the old client-only version. */
router.post("/users/:id/reset-password", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "User not found." });

  await prisma.auditLogEntry.create({
    data: {
      action: "RESET_PASSWORD",
      gymId: user.gymId || null,
      performedById: req.user.userId,
      newValue: user.email,
      note: `Placeholder only — no reset email was sent. Follow up with ${user.email} out of band until a real reset flow (email provider) exists.`,
    },
  });

  res.json({
    ok: true,
    message: `Logged a password-reset request for ${user.email}. No email was actually sent — follow up with the owner directly for now.`,
  });
});

export default router;
