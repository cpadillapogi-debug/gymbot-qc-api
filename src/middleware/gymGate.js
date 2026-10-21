/* ============================================================
   GYMBOT QC API — GYM GATE
   Use AFTER requireAuth on every Gym-Owner-facing route. Two things:
     1. Blocks a Gym Owner whose gym was soft-deleted (same account-
        lifecycle boundary admin.js's /gyms/:id/delete sets) — a
        deleted gym's owner session is still technically valid (the
        JWT hasn't expired) but should no longer be able to use the
        API. DEVELOPER sessions always pass through; Developers have no
        gym of their own and need the gym list endpoints to keep
        working regardless of any one gym's state.
     2. Optionally enforces subscription access (accountLocked /
        dashboardReadOnly) — see services/subscription.js's
        getSubscriptionAccess(). accountLocked blocks every request;
        dashboardReadOnly only blocks non-safe methods (mutations),
        same split the frontend's billing banner already drew.

   Billing routes mount this with { enforceSubscription: false } so a
   Suspended/Disabled owner can still submit a GCash payment to get
   themselves unstuck — see routes/billing.js.
   ============================================================ */
import { prisma } from "../db.js";
import { getSubscription, getSubscriptionAccess } from "../services/subscription.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function gymGate({ enforceSubscription = true } = {}) {
  return async (req, res, next) => {
    try {
      if (req.user?.role === "DEVELOPER") return next();

      const gymId = req.user?.gymId;
      if (!gymId) {
        return res.status(403).json({ error: "This account has no gym associated with it." });
      }

      const gym = await prisma.gym.findUnique({ where: { id: gymId } });
      if (!gym || gym.deletedAt) {
        return res.status(403).json({ error: "This gym account is no longer active." });
      }

      if (enforceSubscription) {
        const sub = await getSubscription(gymId);
        const access = getSubscriptionAccess(sub?.status);
        if (access.accountLocked) {
          return res.status(402).json({ error: "This account is disabled. Contact support to reactivate it.", subscriptionStatus: sub?.status });
        }
        if (access.dashboardReadOnly && !SAFE_METHODS.has(req.method)) {
          return res.status(402).json({ error: "This account is read-only until your subscription is reactivated.", subscriptionStatus: sub?.status });
        }
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
