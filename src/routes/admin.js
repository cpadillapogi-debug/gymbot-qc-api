import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import { getMaintenanceState, setMaintenanceState } from "../middleware/maintenance.js";
import {
  getSubscription,
  getSubscriptionAccess,
  getTrialDaysRemaining,
  getAmountDue,
  isValidPlanId,
  getPlan,
  activateGymManually,
  suspendGymManually,
  disableGymManually,
  reactivateSubscription,
  extendTrial,
  changeSubscriptionPlanDirect,
  applyRequestedPlanUpgrade,
  changeBillingDate,
  setSubscriptionStatusManually,
} from "../services/subscription.js";
import { getGymSettings } from "../services/gymSettings.js";
import { getGymPlatformConfig } from "../services/gymPlatformConfig.js";
 
const router = Router();
 
// Every route below requires a logged-in DEVELOPER. requireAuth checks
// the session cookie is valid; requireRole checks the role on THAT
// verified session — never trust a role passed in from the client.
router.use(requireAuth, requireRole("DEVELOPER"));
 
function toSafeUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}
 
/* ---------- GET /admin/stats ----------
   Platform-wide overview across every gym — the numbers a Developer
   actually wants on first login: how many gyms exist, how many are
   active vs trialing vs churned, total leads generated, and revenue
   collected so far. Everything computed in the database rather than
   pulling every row into Node and counting there. */
router.get("/stats", async (req, res) => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
 
  const [
    totalGyms,
    newGymsThisWeek,
    subscriptionsByStatus,
    totalLeads,
    leadsThisWeek,
    convertedLeads,
    approvedPayments,
    pendingPayments,
  ] = await Promise.all([
    prisma.gym.count(),
    prisma.gym.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.lead.count(),
    prisma.lead.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.lead.count({ where: { status: "Converted" } }),
    // Only "approved" payments count toward real revenue — "submitted"
    // ones are still awaiting manual review and could be rejected.
    prisma.gcashPayment.aggregate({
      where: { status: "approved", createdAt: { gte: thirtyDaysAgo } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.gcashPayment.count({ where: { status: "submitted" } }),
  ]);
 
  const statusCounts = {};
  for (const row of subscriptionsByStatus) statusCounts[row.status] = row._count._all;
 
  res.json({
    gyms: {
      total: totalGyms,
      newThisWeek: newGymsThisWeek,
      byStatus: statusCounts, // e.g. { trialing: 4, active: 12, suspended: 1 }
    },
    leads: {
      total: totalLeads,
      newThisWeek: leadsThisWeek,
      converted: convertedLeads,
    },
    revenue: {
      last30Days: approvedPayments._sum.amount || 0,
      paymentsLast30Days: approvedPayments._count._all,
      pendingReview: pendingPayments, // payments submitted but not yet approved/rejected
    },
  });
});
 
/* ---------- GET /admin/gyms/:id/settings, /admin/gyms/:id/platform-config ----------
   Developer-only, read-only cross-tenant views (support/registry use).
   Writes stay owner-only via /gym-settings/me and /gym-platform-config/me. */
router.get("/gyms/:id/settings", async (req, res) => {
  const gym = await prisma.gym.findUnique({ where: { id: req.params.id } });
  if (!gym) return res.status(404).json({ error: "Gym not found." });
  res.json({ settings: await getGymSettings(gym.id) });
});
 
router.get("/gyms/:id/platform-config", async (req, res) => {
  const gym = await prisma.gym.findUnique({ where: { id: req.params.id } });
  if (!gym) return res.status(404).json({ error: "Gym not found." });
  res.json({ config: await getGymPlatformConfig(gym.id) });
});
 
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
      action: "delete_account",
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
      action: "restore_account",
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
 
  const ownerGym = await prisma.gym.findUnique({ where: { ownerId: user.id } });
  await prisma.auditLogEntry.create({
    data: {
      action: "reset_password_placeholder",
      gymId: ownerGym?.id || null,
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
 
/* ============================================================
   DEVELOPER-ONLY SUBSCRIPTION OVERRIDES
   Every mutation below is audit-logged at the point of mutation (not
   left to the UI layer to remember), same pattern as the gym delete/
   restore routes above. Action strings match the frontend's
   AUDIT_ACTIONS constants in js/config.js so the Developer Audit Log
   page's labels resolve correctly instead of falling back to the raw
   string.
   ============================================================ */
 
function toApiSubscription(sub) {
  if (!sub) return null;
  const access = getSubscriptionAccess(sub.status);
  return {
    gymId: sub.gymId,
    planId: sub.planId,
    planName: getPlan(sub.planId).name,
    status: sub.status,
    statusSince: sub.statusSince,
    trialEndDate: sub.trialEndDate,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    nextBillingDate: sub.nextBillingDate,
    canceledAt: sub.canceledAt,
    requestedPlanId: sub.requestedPlanId,
    requestedPlanName: sub.requestedPlanId ? getPlan(sub.requestedPlanId).name : null,
    upgradeRequestedAt: sub.upgradeRequestedAt,
    trialDaysRemaining: getTrialDaysRemaining(sub),
    amountDue: getAmountDue(sub),
    access,
  };
}
 
async function logSubscriptionAction({ action, gymId, performedById, previousValue, newValue, note }) {
  await prisma.auditLogEntry.create({
    data: { action, gymId, performedById, previousValue: previousValue == null ? null : String(previousValue), newValue: newValue == null ? null : String(newValue), note: note || null },
  });
}
 
/* GET /admin/gyms/:id/subscription */
router.get("/gyms/:id/subscription", async (req, res) => {
  const sub = await getSubscription(req.params.id);
  if (!sub) return res.status(404).json({ error: "Gym not found." });
  res.json({ subscription: toApiSubscription(sub) });
});
 
/* POST /admin/gyms/:id/subscription/activate */
router.post("/gyms/:id/subscription/activate", async (req, res) => {
  const result = await activateGymManually(req.params.id);
  if (!result) return res.status(404).json({ error: "Gym not found." });
  await logSubscriptionAction({ action: "activate_account", gymId: req.params.id, performedById: req.user.userId, previousValue: result.previousStatus, newValue: result.updated.status });
  res.json({ ok: true, subscription: toApiSubscription(result.updated) });
});
 
/* POST /admin/gyms/:id/subscription/suspend  @body {reason?} */
router.post("/gyms/:id/subscription/suspend", async (req, res) => {
  const reason = (req.body || {}).reason || "";
  const result = await suspendGymManually(req.params.id);
  if (!result) return res.status(404).json({ error: "Gym not found." });
  await logSubscriptionAction({ action: "suspend_account", gymId: req.params.id, performedById: req.user.userId, previousValue: result.previousStatus, newValue: result.updated.status, note: reason });
  res.json({ ok: true, subscription: toApiSubscription(result.updated) });
});
 
/* POST /admin/gyms/:id/subscription/disable  @body {reason?} */
router.post("/gyms/:id/subscription/disable", async (req, res) => {
  const reason = (req.body || {}).reason || "";
  const result = await disableGymManually(req.params.id);
  if (!result) return res.status(404).json({ error: "Gym not found." });
  await logSubscriptionAction({ action: "disable_account", gymId: req.params.id, performedById: req.user.userId, previousValue: result.previousStatus, newValue: result.updated.status, note: reason });
  res.json({ ok: true, subscription: toApiSubscription(result.updated) });
});
 
/* POST /admin/gyms/:id/subscription/reactivate */
router.post("/gyms/:id/subscription/reactivate", async (req, res) => {
  const result = await reactivateSubscription(req.params.id);
  if (!result) return res.status(404).json({ error: "Gym not found." });
  if (result.error) return res.status(409).json({ error: result.error });
  await logSubscriptionAction({ action: "activate_account", gymId: req.params.id, performedById: req.user.userId, previousValue: result.previousStatus, newValue: result.updated.status, note: "Reactivate override (fresh billing period started)." });
  res.json({ ok: true, subscription: toApiSubscription(result.updated) });
});
 
/* POST /admin/gyms/:id/subscription/extend-trial  @body {days} */
router.post("/gyms/:id/subscription/extend-trial", async (req, res) => {
  const result = await extendTrial(req.params.id, (req.body || {}).days);
  if (!result) return res.status(404).json({ error: "Gym not found." });
  if (result.error) return res.status(400).json({ error: result.error });
  await logSubscriptionAction({ action: "extend_trial", gymId: req.params.id, performedById: req.user.userId, previousValue: result.previousTrialEnd, newValue: result.newTrialEnd, note: `+${(req.body || {}).days} day(s)` });
  res.json({ ok: true, subscription: toApiSubscription(result.updated) });
});
 
/* POST /admin/gyms/:id/subscription/change-plan  @body {planId} */
router.post("/gyms/:id/subscription/change-plan", async (req, res) => {
  const planId = (req.body || {}).planId;
  if (!isValidPlanId(planId)) return res.status(400).json({ error: "Unknown plan." });
  const result = await changeSubscriptionPlanDirect(req.params.id, planId);
  if (!result) return res.status(404).json({ error: "Gym not found." });
  if (result.error) return res.status(409).json({ error: result.error });
  await logSubscriptionAction({ action: "change_plan", gymId: req.params.id, performedById: req.user.userId, previousValue: result.previousPlanId, newValue: result.updated.planId });
  res.json({ ok: true, subscription: toApiSubscription(result.updated) });
});
 
/* POST /admin/gyms/:id/subscription/apply-upgrade */
router.post("/gyms/:id/subscription/apply-upgrade", async (req, res) => {
  const result = await applyRequestedPlanUpgrade(req.params.id);
  if (!result) return res.status(404).json({ error: "Gym not found." });
  if (result.error) return res.status(409).json({ error: result.error });
  await logSubscriptionAction({ action: "apply_requested_upgrade", gymId: req.params.id, performedById: req.user.userId, previousValue: result.previousPlanId, newValue: result.updated.planId });
  res.json({ ok: true, subscription: toApiSubscription(result.updated) });
});
 
/* POST /admin/gyms/:id/subscription/change-billing-date  @body {date} */
router.post("/gyms/:id/subscription/change-billing-date", async (req, res) => {
  const result = await changeBillingDate(req.params.id, (req.body || {}).date);
  if (!result) return res.status(404).json({ error: "Gym not found." });
  if (result.error) return res.status(400).json({ error: result.error });
  await logSubscriptionAction({ action: "change_billing_date", gymId: req.params.id, performedById: req.user.userId, previousValue: result.previousDate, newValue: result.updated.nextBillingDate });
  res.json({ ok: true, subscription: toApiSubscription(result.updated) });
});
 
/* POST /admin/gyms/:id/subscription/set-status  @body {status} */
router.post("/gyms/:id/subscription/set-status", async (req, res) => {
  const status = (req.body || {}).status;
  const result = await setSubscriptionStatusManually(req.params.id, status);
  if (!result) return res.status(404).json({ error: "Gym not found." });
  if (result.error) return res.status(400).json({ error: result.error });
  await logSubscriptionAction({ action: "change_status", gymId: req.params.id, performedById: req.user.userId, previousValue: result.previousStatus, newValue: result.updated.status });
  res.json({ ok: true, subscription: toApiSubscription(result.updated) });
});
 
/* ============================================================
   DEVELOPER AUDIT LOG — real server records only (no client can ever
   write to this table directly; every entry above is written
   server-side at the moment of the action it describes).
   GET /admin/audit-log?gymId=&action=&days=&page=&pageSize=
   ============================================================ */
router.get("/audit-log", async (req, res) => {
  const { gymId, action } = req.query;
  const days = Number(req.query.days || 0);
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize || 50)));
 
  const where = {};
  if (gymId) where.gymId = gymId;
  if (action) where.action = action;
  if (days > 0) where.createdAt = { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
 
  const [entries, total] = await Promise.all([
    prisma.auditLogEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { performedBy: true, gym: true },
    }),
    prisma.auditLogEntry.count({ where }),
  ]);
 
  res.json({
    entries: entries.map((e) => ({
      id: e.id,
      action: e.action,
      gymId: e.gymId,
      // Server-joined so the frontend never has to do a per-entry gym
      // lookup (and never falls back to a stale local cache) just to
      // label a row — see admin-audit-log-ui.js's gymLabel().
      gymName: e.gym?.name || null,
      previousValue: e.previousValue,
      newValue: e.newValue,
      note: e.note,
      performedBy: e.performedBy?.email || "(unknown developer)",
      timestamp: e.createdAt,
    })),
    total,
    page,
    pageSize,
  });
});
 
/* ============================================================
   MAINTENANCE MODE (platform-wide kill switch)
   ============================================================ */
router.get("/maintenance", async (req, res) => {
  res.json(await getMaintenanceState());
});
 
router.put("/maintenance", async (req, res) => {
  const { enabled, message } = req.body || {};
  const state = await setMaintenanceState(Boolean(enabled), message);
  await prisma.auditLogEntry.create({
    data: {
      action: "maintenance_mode_changed",
      gymId: null,
      performedById: req.user.userId,
      newValue: state.enabled ? "enabled" : "disabled",
      note: state.message || null,
    },
  });
  res.json({ ok: true, ...state });
});
 
export default router;