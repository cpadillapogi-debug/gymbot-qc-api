import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";

const router = Router();

// Every route below requires a logged-in user, same boundary as
// leads.js/conversations.js — a Gym Owner only ever reads/writes
// their OWN gym's payments; gymId comes from req.user, never from the
// URL/body. Developer-only routes add requireRole("DEVELOPER") on top.
router.use(requireAuth);

const STATUS_VALUES = ["submitted", "approved", "rejected"];
const REFERENCE_MAX_LEN = 120;
const NOTE_MAX_LEN = 500;
const REASON_MAX_LEN = 500;

function clamp(str, max) {
  return String(str || "").slice(0, max);
}

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
   Blocks a second submission while one is already pending (same rule
   as gcash-payment-service.js's submitPaymentProof). Does NOT touch a
   Subscription/Invoice record — those tables don't exist server-side
   yet (see the schema's SCOPE NOTE) — so this route only records the
   submission itself; syncing subscription status back to "awaiting
   verification" is still the frontend's job for now. */
router.post("/gcash", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const f = req.body || {};
  if (!f.proofImageDataUrl) {
    return res.status(400).json({ error: "Upload a proof-of-payment image first." });
  }
  if (!f.planId || !f.planName || typeof f.amount !== "number" || f.amount <= 0) {
    return res.status(400).json({ error: "Missing or invalid plan/amount." });
  }

  const existing = await prisma.gcashPayment.findFirst({ where: { gymId, status: "submitted" } });
  if (existing) {
    return res.status(409).json({
      error: "You already have a payment awaiting verification — wait for that one to be reviewed before submitting another.",
    });
  }

  const created = await prisma.gcashPayment.create({
    data: {
      gymId,
      planId: clamp(f.planId, 60),
      planName: clamp(f.planName, 120),
      amount: f.amount,
      billingPeriodStart: f.billingPeriodStart ? new Date(f.billingPeriodStart) : null,
      billingPeriodEnd: f.billingPeriodEnd ? new Date(f.billingPeriodEnd) : null,
      proofImageDataUrl: f.proofImageDataUrl,
      proofFileName: clamp(f.proofFileName, 200),
      reference: clamp(f.reference, REFERENCE_MAX_LEN),
      note: clamp(f.note, NOTE_MAX_LEN),
      status: "submitted",
    },
  });

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
