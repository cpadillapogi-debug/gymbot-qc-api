/* ============================================================
   GYMBOT QC API — OWNER DASHBOARD SUMMARY
   One endpoint that answers "what does my home page need" in a
   single round trip, instead of the frontend firing off separate
   requests to /subscriptions/me, /leads/stats, /conversations/stats
   and stitching them together client-side. Everything here is a
   read of data that's already computed/queried elsewhere — this
   route doesn't introduce any new business logic of its own.
   ============================================================ */
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { gymGate } from "../middleware/gymGate.js";
import {
  getSubscription,
  getSubscriptionAccess,
  getTrialDaysRemaining,
  getAmountDue,
  getPlan,
} from "../services/subscription.js";
 
const router = Router();
 
router.use(requireAuth, gymGate());
 
/* ---------- GET /dashboard/me ---------- */
router.get("/me", async (req, res) => {
  const gymId = req.user.gymId;
  if (!gymId) {
    return res.status(403).json({ error: "This account has no gym associated with it." });
  }
 
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
 
  const [gym, subscription, leadTotal, leadsThisWeek, leadsConverted, convoTotal, convoWithLead, convoOpen] =
    await Promise.all([
      prisma.gym.findUnique({ where: { id: gymId }, select: { name: true } }),
      getSubscription(gymId),
      prisma.lead.count({ where: { gymId } }),
      prisma.lead.count({ where: { gymId, createdAt: { gte: sevenDaysAgo } } }),
      prisma.lead.count({ where: { gymId, status: "Converted" } }),
      prisma.conversation.count({ where: { gymId } }),
      prisma.conversation.count({ where: { gymId, leadId: { not: null } } }),
      prisma.conversation.count({ where: { gymId, status: "open" } }),
    ]);
 
  const plan = subscription ? getPlan(subscription.planId) : null;
 
  res.json({
    gymName: gym?.name || "",
    subscription: subscription
      ? {
          status: subscription.status,
          planId: subscription.planId,
          planName: plan?.name || subscription.planId,
          access: getSubscriptionAccess(subscription.status),
          trialDaysRemaining: getTrialDaysRemaining(subscription),
          amountDue: getAmountDue(subscription),
          nextBillingDate: subscription.nextBillingDate,
        }
      : null,
    leads: {
      total: leadTotal,
      newThisWeek: leadsThisWeek,
      converted: leadsConverted,
    },
    conversations: {
      total: convoTotal,
      openNow: convoOpen,
      leadCaptureRate: convoTotal > 0 ? Math.round((convoWithLead / convoTotal) * 100) : null,
    },
  });
});
 
export default router;