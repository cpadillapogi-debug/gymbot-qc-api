import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";

const router = Router();

// Every route below requires a logged-in user. Gym Owners only ever
// see/touch their OWN gym's leads — gymId comes from req.user (the
// verified session), never from the URL or body. This is the same
// boundary leads-service.js's docstring calls for on the frontend;
// here it's enforced server-side, which the client can't bypass.
router.use(requireAuth);

const LEAD_STATUSES = ["New", "Contacted", "Scheduled", "Trial Completed", "Converted", "Lost"];
const NAME_MAX_LEN = 120;
const PHONE_MAX_LEN = 40;
const NOTES_MAX_LEN = 4000;

function clamp(str, max) {
  return String(str || "").slice(0, max);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "");
}

// Loose PH-friendly match: strip everything but digits, compare the
// last 10 (drops leading 0/63 country-code variance) — same intent as
// the frontend's normalizePhoneForMatch().
function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.slice(-10);
}

// A Gym Owner's gymId lives on their session (set at login/register).
// A Developer has no gym of their own — 403 rather than silently
// returning nothing, so a misconfigured client finds out immediately.
function requireGymId(req, res) {
  if (!req.user.gymId) {
    res.status(403).json({ error: "This account has no gym associated with it." });
    return null;
  }
  return req.user.gymId;
}

function toApiLead(lead) {
  return {
    id: lead.id,
    gymId: lead.gymId,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    goal: lead.goal,
    preferredTime: lead.preferredTime,
    source: lead.source,
    status: lead.status,
    notes: lead.notes,
    conversationSummary: lead.conversationSummary,
    statusHistory: lead.statusHistory,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
    lastActivityAt: lead.lastActivityAt,
  };
}

/* ---------- GET /leads ---------- */
// Backs getLeads(gymId) — newest first, this gym only.
router.get("/", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const leads = await prisma.lead.findMany({
    where: { gymId },
    orderBy: { createdAt: "desc" },
  });
  res.json({ leads: leads.map(toApiLead) });
});

/* ---------- GET /leads/:id ---------- */
// Backs getLeadById(gymId, leadId).
router.get("/:id", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const lead = await prisma.lead.findFirst({ where: { id: req.params.id, gymId } });
  if (!lead) return res.status(404).json({ error: "Lead not found." });
  res.json({ lead: toApiLead(lead) });
});

/* ---------- POST /leads ---------- */
// Backs captureLead() — creates a New lead, or updates the existing
// one in place if a lead with the same phone already exists for this
// gym (same dedup rule as the frontend's findLeadByPhone()).
// Never blanks a field we already had with an empty new value.
router.post("/", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const f = req.body || {};
  const cleanName = clamp((f.name || "").trim(), NAME_MAX_LEN);
  const cleanPhone = clamp((f.phone || "").trim(), PHONE_MAX_LEN);
  const digitCount = (cleanPhone.match(/\d/g) || []).length;

  if (cleanName.length < 2) return res.status(400).json({ error: "Please enter your name." });
  if (digitCount < 7) return res.status(400).json({ error: "Please enter a valid phone number." });

  const phoneKey = normalizePhone(cleanPhone);
  const candidates = await prisma.lead.findMany({ where: { gymId } });
  const existing = phoneKey ? candidates.find((l) => normalizePhone(l.phone) === phoneKey) : null;

  const now = new Date();

  if (existing) {
    const updated = await prisma.lead.update({
      where: { id: existing.id },
      data: {
        name: f.name || existing.name,
        email: f.email || existing.email,
        goal: f.goal || existing.goal,
        preferredTime: f.preferredTime || existing.preferredTime,
        source: f.source || existing.source,
        conversationSummary: f.conversationSummary || existing.conversationSummary,
        lastActivityAt: now,
      },
    });
    return res.json({ lead: toApiLead(updated), created: false });
  }

  const created = await prisma.lead.create({
    data: {
      gymId,
      name: cleanName,
      phone: cleanPhone,
      email: isValidEmail(f.email) ? f.email.trim() : "",
      goal: f.goal || "",
      preferredTime: f.preferredTime || "",
      source: f.source || "Website",
      status: "New",
      notes: "",
      conversationSummary: f.conversationSummary || "",
      statusHistory: [{ status: "New", at: now.toISOString() }],
      lastActivityAt: now,
    },
  });
  res.status(201).json({ lead: toApiLead(created), created: true });
});

/* ---------- PATCH /leads/:id/status ---------- */
// Backs updateLeadStatus() — appends to statusHistory rather than
// overwriting it, same as the frontend.
router.patch("/:id/status", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const { status } = req.body || {};
  if (!LEAD_STATUSES.includes(status)) {
    return res.status(400).json({ error: "Not a valid status." });
  }

  const lead = await prisma.lead.findFirst({ where: { id: req.params.id, gymId } });
  if (!lead) return res.status(404).json({ error: "Lead not found." });

  const now = new Date();
  const history = Array.isArray(lead.statusHistory) ? lead.statusHistory : [];
  const updated = await prisma.lead.update({
    where: { id: lead.id },
    data: {
      status,
      lastActivityAt: now,
      statusHistory: history.concat([{ status, at: now.toISOString() }]),
    },
  });
  res.json({ lead: toApiLead(updated) });
});

/* ---------- PATCH /leads/:id/notes ---------- */
// Backs updateLeadNotes().
router.patch("/:id/notes", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const lead = await prisma.lead.findFirst({ where: { id: req.params.id, gymId } });
  if (!lead) return res.status(404).json({ error: "Lead not found." });

  const updated = await prisma.lead.update({
    where: { id: lead.id },
    data: { notes: clamp(String((req.body || {}).notes || ""), NOTES_MAX_LEN) },
  });
  res.json({ lead: toApiLead(updated) });
});

/* ---------- DELETE /leads/:id ---------- */
// Backs deleteLead(). Hard delete, matching the frontend's current
// behavior — there's no soft-delete/undo for individual leads (unlike
// gyms, which use deletedAt). Flag this in the roadmap if that turns
// out to be needed later.
router.delete("/:id", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const lead = await prisma.lead.findFirst({ where: { id: req.params.id, gymId } });
  if (!lead) return res.status(404).json({ error: "Lead not found." });

  await prisma.lead.delete({ where: { id: lead.id } });
  res.json({ ok: true });
});

/* ---------- DELETE /leads (bulk clear) ----------
   Backs the owner-facing "Clear all leads" button
   (owner-leads-page-ui.js). Deletes every lead for the caller's own
   gym in one operation — no per-lead loop from the client, so this
   can't partially succeed the way a client-side loop-of-deletes
   could on a mid-loop network failure. */
router.delete("/", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const { count } = await prisma.lead.deleteMany({ where: { gymId } });
  res.json({ ok: true, deleted: count });
});

/* ---------- POST /leads/bulk (restore from backup) ----------
   Backs owner-backup-service.js's importOwnerBackup(). Replaces this
   gym's ENTIRE lead list with the incoming array, atomically: either
   every lead in the backup is written or none are (via a transaction),
   so a bad record partway through can't leave the gym with a mix of
   old and new data.

   Every incoming record is force-tagged with the caller's OWN gymId —
   mirrors what replaceLeadsForGym() already promises on the frontend
   ("ignoring whatever gymId it arrived with") — so a crafted backup
   file can never plant leads into a different gym, even if it lists
   a different gymId internally. Unknown/extra fields on each record
   are dropped rather than passed through, so a malformed backup can't
   inject arbitrary columns.
   @body {leads: object[]} */
router.post("/bulk", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const incoming = (req.body || {}).leads;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: "Expected a 'leads' array." });
  }
  if (incoming.length > 5000) {
    return res.status(400).json({ error: "Backup file has too many leads to restore at once." });
  }

  const now = new Date();
  const rows = incoming.map((l) => {
    const src = l && typeof l === "object" ? l : {};
    const cleanName = clamp((src.name || "").trim(), NAME_MAX_LEN);
    const cleanPhone = clamp((src.phone || "").trim(), PHONE_MAX_LEN);
    const status = LEAD_STATUSES.includes(src.status) ? src.status : "New";
    return {
      gymId, // forced — never trust the incoming record's own gymId
      name: cleanName,
      phone: cleanPhone,
      email: isValidEmail(src.email) ? src.email.trim() : "",
      goal: clamp(src.goal || "", 200),
      preferredTime: clamp(src.preferredTime || "", 200),
      source: clamp(src.source || "Website", 100),
      status,
      notes: clamp(src.notes || "", NOTES_MAX_LEN),
      conversationSummary: clamp(src.conversationSummary || "", 4000),
      statusHistory: Array.isArray(src.statusHistory) ? src.statusHistory : [{ status, at: now.toISOString() }],
      createdAt: src.createdAt && !isNaN(Date.parse(src.createdAt)) ? new Date(src.createdAt) : now,
      lastActivityAt: src.lastActivityAt && !isNaN(Date.parse(src.lastActivityAt)) ? new Date(src.lastActivityAt) : now,
    };
  });

  const restored = await prisma.$transaction(async (tx) => {
    await tx.lead.deleteMany({ where: { gymId } });
    if (rows.length > 0) {
      await tx.lead.createMany({ data: rows });
    }
    return tx.lead.findMany({ where: { gymId }, orderBy: { createdAt: "desc" } });
  });

  res.json({ ok: true, leads: restored.map(toApiLead) });
});

/* ---------- GET /leads/admin/:gymId (Developer-only) ----------
   Lets the Developer console view any gym's leads (e.g. for support),
   without giving Gym Owners a way to reach other gyms' data — this
   route requires DEVELOPER role explicitly, on top of requireAuth. */
router.get("/admin/:gymId", requireRole("DEVELOPER"), async (req, res) => {
  const leads = await prisma.lead.findMany({
    where: { gymId: req.params.gymId },
    orderBy: { createdAt: "desc" },
  });
  res.json({ leads: leads.map(toApiLead) });
});

export default router;
