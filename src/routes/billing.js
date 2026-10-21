import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import { gymGate } from "../middleware/gymGate.js";
import {
  getSubscription,
  getAmountDue,
  getPlan,
  markSubscriptionAwaitingVerification,
  approveGymPayment,
  rejectGymPayment,
  applyRequestedPlanUpgrade,
} from "../services/subscription.js";

const router = Router();

// Every route below requires a logged-in user, same boundary as
// leads.js/conversations.js — a Gym Owner only ever reads/writes
// their OWN gym's payments; gymId comes from req.user, never from the
// URL/body. Developer-only routes add requireRole("DEVELOPER") on top.
router.use(requireAuth, gymGate({ enforceSubscription: false }));

const STATUS_VALUES = ["submitted", "approved", "rejected"];
const REFERENCE_MAX_LEN = 120;
const NOTE_MAX_LEN = 500;
const REASON_MAX_LEN = 500;

function clamp(str, max) {
  return String(str || "").slice(0, max);
}

const GCASH_SETTINGS_KEY = "gcashSettings";
const GCASH_NUMBER_MAX_LEN = 30;
const ACCOUNT_NAME_MAX_LEN = 120;

/* ---------- GET /billing/gcash-settings — where to send payment ----------
   Any authenticated gym owner (or Developer) can read this: it's the
   QR/number/account-name an owner pays to, not a secret. Backed by the
   generic PlatformSetting key/value table, same pattern as maintenance
   mode — one row, platform-wide (GymBot QC has a single GCash account,
   not one per gym). */
router.get("/gcash-settings", async (req, res) => {
  const row = await prisma.platformSetting.findUnique({ where: { key: GCASH_SETTINGS_KEY } });
  const value = row?.value || {};
  res.json({
    settings: {
      qrImageDataUrl: value.qrImageDataUrl || "",
      gcashNumber: value.gcashNumber || "",
      accountName: value.accountName || "",
    },
    configured: Boolean(value.gcashNumber || value.qrImageDataUrl),
  });
});

/* ---------- PUT /billing/gcash-settings — Developer only ---------- */
router.put("/gcash-settings", requireRole("DEVELOPER"), async (req, res) => {
  const f = req.body || {};
  const value = {
    qrImageDataUrl: typeof f.qrImageDataUrl === "string" ? f.qrImageDataUrl : "",
    gcashNumber: clamp(f.gcashNumber, GCASH_NUMBER_MAX_LEN),
    accountName: clamp(f.accountName, ACCOUNT_NAME_MAX_LEN),
  };
  await prisma.platformSetting.upsert({
    where: { key: GCASH_SETTINGS_KEY },
    update: { value },
    create: { key: GCASH_SETTINGS_KEY, value },
  });
  await prisma.auditLogEntry.create({
    data: {
      action: "update_gcash_settings",
      gymId: null,
      performedById: req.user.userId,
      note: "GCash receiving account/QR updated.",
    },
  });
  res.json({ ok: true, settings: value });
});

function requireGymId(req, res) {
  if (!req.user.gymId) {
    res.status(403).json({ error: "This account has no gym associated with it." });
    return null;
  }
  return req.user.gymId;
}

function toApiPayment(p) {
  return {
    id: p.id,
    gymId: p.gymId,
    planId: p.planId,
    planName: p.planName,
    amount: p.amount,
    billingPeriodStart: p.billingPeriodStart,
    billingPeriodEnd: p.billingPeriodEnd,
    proofImageDataUrl: p.proofImageDataUrl,
    proofFileName: p.proofFileName,
    reference: p.reference,
    note: p.note,
    status: p.status,
    submittedAt: p.submittedAt,
    decidedAt: p.decidedAt,
    decidedByEmail: p.decidedByEmail,
    rejectionReason: p.rejectionReason,
    // internalNote deliberately omitted for non-Developer callers — see
    // GET /billing/gcash/admin/:id below, the only route that includes it.
  };
}

/* ---------- GET /billing/gcash — this gym's own payment history ---------- */
router.get("/gcash", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const payments = await prisma.gcashPayment.findMany({
    where: { gymId },
    orderBy: { submittedAt: "desc" },
  });
  res.json({ payments: payments.map(toApiPayment) });
});

/* ---------- GET /billing/gcash/pending — this gym's awaiting-verification payment, if any ---------- */
router.get("/gcash/pending", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const payment = await prisma.gcashPayment.findFirst({
    where: { gymId, status: "submitted" },
    orderBy: { submittedAt: "desc" },
  });
  res.json({ payment: payment ? toApiPayment(payment) : null });
});

/* ---------- POST /billing/gcash — submit a proof of payment ----------
   FINANCIAL INTEGRITY: planId/planName/amount are NEVER taken from the
   request body. They are derived entirely from this gym's own stored
   subscription (services/subscription.js's getSubscription() +
   getAmountDue()) — a client can only control the proof image, an
   optional human-readable reference, and an optional note. This closes
   a real gap where a caller could previously submit an arbitrary
   amount/plan and have it recorded as if it were authoritative.
   Blocks a second submission while one is already pending (same rule
   as the frontend's old gcash-payment-service.js). On success, also
   flips the subscription to "pending_payment" (awaiting verification)
   so the owner/Developer dashboards immediately reflect that a review
   is in progress. */
router.post("/gcash", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const f = req.body || {};
  if (!f.proofImageDataUrl) {
    return res.status(400).json({ error: "Upload a proof-of-payment image first." });
  }

  const existing = await prisma.gcashPayment.findFirst({ where: { gymId, status: "submitted" } });
  if (existing) {
    return res.status(409).json({
      error: "You already have a payment awaiting verification — wait for that one to be reviewed before submitting another.",
    });
  }

  const sub = await getSubscription(gymId);
  if (!sub) return res.status(404).json({ error: "Gym not found." });

  // The plan being paid for is the requested upgrade if one is pending,
  // otherwise the gym's current plan — never a client-supplied planId.
  const payingForPlanId = sub.requestedPlanId || sub.planId;
  const plan = getPlan(payingForPlanId);
  const amount = sub.requestedPlanId ? plan.priceMonthly : (getAmountDue(sub) || plan.priceMonthly);

  const created = await prisma.gcashPayment.create({
    data: {
      gymId,
      planId: plan.id,
      planName: plan.name,
      amount,
      billingPeriodStart: sub.currentPeriodStart || null,
      billingPeriodEnd: sub.currentPeriodEnd || null,
      proofImageDataUrl: f.proofImageDataUrl,
      proofFileName: clamp(f.proofFileName, 200),
      reference: clamp(f.reference, REFERENCE_MAX_LEN),
      note: clamp(f.note, NOTE_MAX_LEN),
      status: "submitted",
    },
  });

  // Only move status toward "pending_payment" when doing so does not
  // LOOSEN access — a Suspended/Disabled gym stays locked purely on the
  // strength of submitting a proof image; only a Developer's actual
  // approval (approveGymPayment -> activateGymManually, below) can
  // restore access. Otherwise a malicious owner could self-unlock by
  // submitting junk proof and waiting for the review queue.
  const LOCKED_STATUSES = ["suspended", "disabled"];
  if (!LOCKED_STATUSES.includes(sub.status)) {
    await markSubscriptionAwaitingVerification(gymId);
  }

  res.status(201).json({
    ok: true,
    message: "Payment submitted — we'll verify it and update your account shortly.",
    payment: toApiPayment(created),
  });
});

/* ---------- Developer-only queue + decisions ---------- */

/* GET /billing/gcash/admin/queue — every Submitted payment, oldest first (FIFO review) */
router.get("/gcash/admin/queue", requireRole("DEVELOPER"), async (req, res) => {
  const payments = await prisma.gcashPayment.findMany({
    where: { status: "submitted" },
    orderBy: { submittedAt: "asc" },
  });
  res.json({ payments: payments.map((p) => Object.assign(toApiPayment(p), { internalNote: p.internalNote })) });
});

/* GET /billing/gcash/admin/all — every payment ever submitted, any status */
router.get("/gcash/admin/all", requireRole("DEVELOPER"), async (req, res) => {
  const payments = await prisma.gcashPayment.findMany({ orderBy: { submittedAt: "desc" } });
  res.json({ payments: payments.map((p) => Object.assign(toApiPayment(p), { internalNote: p.internalNote })) });
});

/* PATCH /billing/gcash/admin/:id/approve */
router.patch("/gcash/admin/:id/approve", requireRole("DEVELOPER"), async (req, res) => {
  const payment = await prisma.gcashPayment.findUnique({ where: { id: req.params.id } });
  if (!payment) return res.status(404).json({ error: "Payment not found." });
  if (payment.status !== "submitted") {
    return res.status(409).json({ error: "This payment has already been decided." });
  }

  // The session JWT only carries userId/role/gymId (see requireAuth.js) —
  // no email — so look the deciding Developer's email up for the record.
  const decider = await prisma.user.findUnique({ where: { id: req.user.userId } });

  const updated = await prisma.gcashPayment.update({
    where: { id: payment.id },
    data: {
      status: "approved",
      decidedAt: new Date(),
      decidedByEmail: decider?.email || null,
      rejectionReason: null,
    },
  });

  // This is the step that actually unlocks the account: Active status,
  // fresh billing period. Also applies a pending plan-upgrade request if
  // this payment was for one — never automatic, only on a real Developer
  // approval of a real submitted payment.
  const subBefore = await getSubscription(payment.gymId);
  const previousStatus = subBefore?.status;
  await approveGymPayment(payment.gymId);
  if (subBefore?.requestedPlanId) {
    await applyRequestedPlanUpgrade(payment.gymId);
  }

  await prisma.auditLogEntry.create({
    data: {
      action: "approve_gcash_payment",
      gymId: payment.gymId,
      performedById: req.user.userId,
      previousValue: previousStatus || null,
      newValue: "active",
      note: `Approved payment ${payment.id} (${payment.planName}, ₱${payment.amount}).`,
    },
  });

  res.json({ ok: true, payment: toApiPayment(updated) });
});

/* PATCH /billing/gcash/admin/:id/reject  @body {reason: string} */
router.patch("/gcash/admin/:id/reject", requireRole("DEVELOPER"), async (req, res) => {
  const payment = await prisma.gcashPayment.findUnique({ where: { id: req.params.id } });
  if (!payment) return res.status(404).json({ error: "Payment not found." });
  if (payment.status !== "submitted") {
    return res.status(409).json({ error: "This payment has already been decided." });
  }

  const reason = clamp((req.body || {}).reason, REASON_MAX_LEN);
  if (!reason) return res.status(400).json({ error: "A rejection reason is required." });

  const decider = await prisma.user.findUnique({ where: { id: req.user.userId } });

  const updated = await prisma.gcashPayment.update({
    where: { id: payment.id },
    data: {
      status: "rejected",
      decidedAt: new Date(),
      decidedByEmail: decider?.email || null,
      rejectionReason: reason,
    },
  });

  // Mirror the same "never loosen a lock" rule as the approve path: only
  // move the subscription back to pending_payment if it isn't currently
  // Suspended/Disabled (those stay exactly as locked as they were).
  const subBefore = await getSubscription(payment.gymId);
  const previousStatus = subBefore?.status;
  const LOCKED_STATUSES = ["suspended", "disabled"];
  if (subBefore && !LOCKED_STATUSES.includes(subBefore.status)) {
    await rejectGymPayment(payment.gymId);
  }

  await prisma.auditLogEntry.create({
    data: {
      action: "reject_gcash_payment",
      gymId: payment.gymId,
      performedById: req.user.userId,
      previousValue: previousStatus || null,
      newValue: subBefore && !LOCKED_STATUSES.includes(subBefore.status) ? "pending_payment" : previousStatus,
      note: `Rejected payment ${payment.id}: ${reason}`,
    },
  });

  res.json({ ok: true, payment: toApiPayment(updated) });
});

/* PATCH /billing/gcash/admin/:id/note — Developer-only scratchpad, any status  @body {note: string} */
router.patch("/gcash/admin/:id/note", requireRole("DEVELOPER"), async (req, res) => {
  const payment = await prisma.gcashPayment.findUnique({ where: { id: req.params.id } });
  if (!payment) return res.status(404).json({ error: "Payment not found." });

  const updated = await prisma.gcashPayment.update({
    where: { id: payment.id },
    data: { internalNote: clamp((req.body || {}).note, NOTE_MAX_LEN) },
  });
  res.json({ ok: true, payment: Object.assign(toApiPayment(updated), { internalNote: updated.internalNote }) });
});

export default router;
