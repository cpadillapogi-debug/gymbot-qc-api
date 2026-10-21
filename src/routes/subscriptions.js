/* ============================================================
   GYMBOT QC API — OWNER-FACING SUBSCRIPTION ROUTES
   gymId always comes from the verified session (req.user.gymId), never
   from the URL/body — same boundary every other route in this API
   draws. Developer-only overrides live in admin.js, gated by
   requireRole("DEVELOPER") there, not here.
   ============================================================ */
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { gymGate } from "../middleware/gymGate.js";
import {
  getSubscription,
  getSubscriptionAccess,
  getTrialDaysRemaining,
  getAmountDue,
  getAllPlans,
  requestPlanUpgrade,
} from "../services/subscription.js";

const router = Router();

router.use(requireAuth);

function requireGymId(req, res) {
  if (!req.user.gymId) {
    res.status(403).json({ error: "This account has no gym associated with it." });
    return null;
  }
  return req.user.gymId;
}

function toApiSubscription(sub) {
  const access = getSubscriptionAccess(sub.status);
  return {
    gymId: sub.gymId,
    planId: sub.planId,
    status: sub.status,
    statusSince: sub.statusSince,
    trialEndDate: sub.trialEndDate,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    nextBillingDate: sub.nextBillingDate,
    canceledAt: sub.canceledAt,
    requestedPlanId: sub.requestedPlanId,
    upgradeRequestedAt: sub.upgradeRequestedAt,
    trialDaysRemaining: getTrialDaysRemaining(sub),
    amountDue: getAmountDue(sub),
    access,
  };
}

/* ---------- GET /subscriptions/plans — public catalog, no gym-specific data ---------- */
router.get("/plans", (req, res) => {
  res.json({ plans: getAllPlans() });
});

/* ---------- GET /subscriptions/me ---------- */
// enforceSubscription:false — an owner needs to be able to SEE their own
// locked/suspended status (and amount due) in order to do anything about
// it; gymGate here only blocks a soft-deleted gym, not a locked one.
router.get("/me", gymGate({ enforceSubscription: false }), async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const sub = await getSubscription(gymId);
  if (!sub) return res.status(404).json({ error: "Gym not found." });
  res.json({ subscription: toApiSubscription(sub) });
});

/* ---------- POST /subscriptions/me/request-upgrade  @body {planId} ---------- */
router.post("/me/request-upgrade", gymGate({ enforceSubscription: false }), async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const result = await requestPlanUpgrade(gymId, (req.body || {}).planId);
  if (!result.ok) return res.status(400).json({ error: result.reason });
  res.json({ ok: true, message: result.message, subscription: toApiSubscription(result.subscription) });
});

export default router;
