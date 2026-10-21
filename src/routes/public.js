/* ============================================================
   GYMBOT QC API — PUBLIC GYM WIDGET ROUTES
   The ONLY routes in this API reachable without a session cookie —
   this is what widget.html (embedded on a gym's own site, or opened
   directly) talks to. Deliberately kept separate from every private
   admin/owner route:
     - no auth, no CSRF header requirement (see middleware/csrf.js's
       EXEMPT_PREFIXES) — there is no session to protect here.
     - its own, generous-but-real rate limiter keyed by ip+gymId
       (publicWidgetLimiter), since there's no account to throttle by.
     - every route resolves :gymId from the URL and explicitly checks
       the gym exists, isn't soft-deleted, and (for anything that
       would start/continue an AI conversation) that the subscription's
       aiEnabled flag is still true — a Suspended/Disabled gym's widget
       goes dark along with everything else on its dashboard.
     - NO route lists/enumerates gyms. A caller must already know the
       gymId (same "no gym-enumeration route" rule the design doc for
       this feature calls out) — it's an unguessable cuid, not a slug.
     - only ever returns what a public visitor should see: a gym's
       name/settings/FAQs, never owner email, billing, or anything
       from another tenant.
   ============================================================ */
import { Router } from "express";
import { prisma } from "../db.js";
import { publicWidgetLimiter } from "../middleware/rateLimit.js";
import { getSubscription, getSubscriptionAccess } from "../services/subscription.js";
import { getGymSettings, toPublicSettings } from "../services/gymSettings.js";

const router = Router();
router.use(publicWidgetLimiter);

const MESSAGE_TEXT_MAX_LEN = 4000;
const NAME_MAX_LEN = 120;
const PHONE_MAX_LEN = 40;

function clamp(str, max) {
  return String(str || "").slice(0, max);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "");
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

/** Resolves :gymId to a live (not soft-deleted) gym, or sends 404.
 *  Shared by every route below — the one place "does this gym even
 *  exist and is it live" is checked. */
async function loadLiveGym(req, res) {
  const gym = await prisma.gym.findUnique({ where: { id: req.params.gymId } });
  if (!gym || gym.deletedAt) {
    res.status(404).json({ error: "This gym isn't available." });
    return null;
  }
  return gym;
}

/* ---------- GET /public/status — widget-wide health/maintenance probe ---------- */
router.get("/status", (req, res) => {
  res.json({ ok: true });
});

/* ---------- GET /public/:gymId — minimal public gym identity + AI status ---------- */
router.get("/:gymId", async (req, res) => {
  const gym = await loadLiveGym(req, res);
  if (!gym) return;

  const sub = await getSubscription(gym.id);
  const access = getSubscriptionAccess(sub?.status);

  res.json({
    gym: { id: gym.id, name: gym.name },
    aiEnabled: access.aiEnabled,
  });
});

/* ---------- GET /public/:gymId/settings — public business info for the widget/AI prompt ---------- */
router.get("/:gymId/settings", async (req, res) => {
  const gym = await loadLiveGym(req, res);
  if (!gym) return;

  const settings = await getGymSettings(gym.id);
  // Every field on GymSettings is already gym-facing business info meant
  // to be shown to a prospective customer (hours, fees, FAQs, welcome
  // message) — nothing here is a secret, unlike e.g. owner email.
  res.json({ settings: toPublicSettings(settings) });
});

/* ---------- POST /public/:gymId/leads — widget-captured lead, same dedup-by-phone rule as /leads ---------- */
router.post("/:gymId/leads", async (req, res) => {
  const gym = await loadLiveGym(req, res);
  if (!gym) return;

  const sub = await getSubscription(gym.id);
  if (!getSubscriptionAccess(sub?.status).aiEnabled) {
    return res.status(403).json({ error: "This gym's AI receptionist is currently unavailable." });
  }

  const f = req.body || {};
  const cleanName = clamp((f.name || "").trim(), NAME_MAX_LEN);
  const cleanPhone = clamp((f.phone || "").trim(), PHONE_MAX_LEN);
  const digitCount = (cleanPhone.match(/\d/g) || []).length;
  if (cleanName.length < 2) return res.status(400).json({ error: "Please enter your name." });
  if (digitCount < 7) return res.status(400).json({ error: "Please enter a valid phone number." });

  const phoneKey = normalizePhone(cleanPhone);
  const candidates = await prisma.lead.findMany({ where: { gymId: gym.id } });
  const existing = phoneKey ? candidates.find((l) => normalizePhone(l.phone) === phoneKey) : null;
  const now = new Date();

  if (existing) {
    const updated = await prisma.lead.update({
      where: { id: existing.id },
      data: {
        name: f.name || existing.name,
        email: isValidEmail(f.email) ? f.email.trim() : existing.email,
        goal: f.goal || existing.goal,
        preferredTime: f.preferredTime || existing.preferredTime,
        source: f.source || existing.source,
        conversationSummary: f.conversationSummary || existing.conversationSummary,
        lastActivityAt: now,
      },
    });
    return res.json({ lead: { id: updated.id, name: updated.name, preferredTime: updated.preferredTime }, created: false });
  }

  const created = await prisma.lead.create({
    data: {
      gymId: gym.id,
      name: cleanName,
      phone: cleanPhone,
      email: isValidEmail(f.email) ? f.email.trim() : "",
      goal: f.goal || "",
      preferredTime: f.preferredTime || "",
      source: f.source || "Website",
      status: "New",
      conversationSummary: f.conversationSummary || "",
      statusHistory: [{ status: "New", at: now.toISOString() }],
      lastActivityAt: now,
    },
  });
  res.status(201).json({ lead: { id: created.id, name: created.name, preferredTime: created.preferredTime }, created: true });
});

/* ---------- POST /public/:gymId/conversations — widget starts a chat thread ---------- */
router.post("/:gymId/conversations", async (req, res) => {
  const gym = await loadLiveGym(req, res);
  if (!gym) return;

  const sub = await getSubscription(gym.id);
  if (!getSubscriptionAccess(sub?.status).aiEnabled) {
    return res.status(403).json({ error: "This gym's AI receptionist is currently unavailable." });
  }

  const f = req.body || {};
  const convo = await prisma.conversation.create({
    data: {
      gymId: gym.id,
      customerName: clamp(f.customerName || "", NAME_MAX_LEN),
      customerPhone: clamp(f.customerPhone || "", PHONE_MAX_LEN),
    },
  });
  res.status(201).json({ conversation: { id: convo.id, gymId: convo.gymId } });
});

/* ---------- POST /public/:gymId/conversations/:id/messages — widget appends a message ---------- */
router.post("/:gymId/conversations/:id/messages", async (req, res) => {
  const gym = await loadLiveGym(req, res);
  if (!gym) return;

  const sub = await getSubscription(gym.id);
  if (!getSubscriptionAccess(sub?.status).aiEnabled) {
    return res.status(403).json({ error: "This gym's AI receptionist is currently unavailable." });
  }

  const { role, text } = req.body || {};
  // A public, unauthenticated caller may only ever post as "customer" —
  // "bot"/"staff" messages come from the gym's own authenticated side
  // (POST /conversations/:id/messages), never from an anonymous widget
  // visitor. This is the boundary that keeps a scripted widget caller
  // from forging a fake "staff" reply into someone's inbox.
  if (role !== "customer") {
    return res.status(400).json({ error: "Not a valid message role for this endpoint." });
  }
  const cleanText = clamp((text || "").trim(), MESSAGE_TEXT_MAX_LEN);
  if (!cleanText) return res.status(400).json({ error: "Message text can't be empty." });

  const convo = await prisma.conversation.findFirst({ where: { id: req.params.id, gymId: gym.id } });
  if (!convo) return res.status(404).json({ error: "Conversation not found." });

  const now = new Date();
  const [message] = await prisma.$transaction([
    prisma.message.create({ data: { conversationId: convo.id, role: "customer", text: cleanText } }),
    prisma.conversation.update({ where: { id: convo.id }, data: { lastMessageAt: now } }),
  ]);
  res.status(201).json({ message: { id: message.id, conversationId: message.conversationId, role: message.role, text: message.text, createdAt: message.createdAt } });
});

export default router;
