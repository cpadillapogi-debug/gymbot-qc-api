import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import { gymGate } from "../middleware/gymGate.js";
import { getGymSettings } from "../services/gymSettings.js";
import { syncLeadsToSheet } from "../services/googleSheets.js";

const router = Router();

// Every route below requires a logged-in user. Gym Owners only ever
// see/touch their OWN gym's leads — gymId comes from req.user (the
// verified session), never from the URL or body. This is the same
// boundary leads-service.js's docstring calls for on the frontend;
// here it's enforced server-side, which the client can't bypass.
router.use(requireAuth, gymGate());

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
// Optional query params, all server-side so a gym with thousands of
// leads doesn't have to ship the whole list to filter or page through:
//   ?status=New            one of LEAD_STATUSES, exact match
//   ?search=jane            matches name, phone, or email (contains,
//                            case-insensitive)
//   ?page=2&pageSize=50     1-indexed; pageSize capped at 200. Omit
//                            both to get everything (old behavior —
//                            existing callers that don't ask for a
//                            page keep working unchanged).
router.get("/", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const { status, search, page, pageSize } = req.query;
  const where = { gymId };

  if (status) {
    if (!LEAD_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Not a valid status." });
    }
    where.status = status;
  }

  if (search && String(search).trim()) {
    const term = String(search).trim();
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { phone: { contains: term, mode: "insensitive" } },
      { email: { contains: term, mode: "insensitive" } },
    ];
  }

  // Paging is opt-in: only kicks in if the caller passes page or
  // pageSize, so the existing frontend (which asks for the full list)
  // doesn't need to change to keep working.
  if (page || pageSize) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50));

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (pageNum - 1) * size,
        take: size,
      }),
      prisma.lead.count({ where }),
    ]);

    return res.json({
      leads: leads.map(toApiLead),
      page: pageNum,
      pageSize: size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size)),
    });
  }

  const leads = await prisma.lead.findMany({ where, orderBy: { createdAt: "desc" } });
  res.json({ leads: leads.map(toApiLead) });
});

/* ---------- GET /leads/stats ----------
   Summary numbers for a dashboard "at a glance" view — counts per
   status plus a few derived figures, computed in the database rather
   than by fetching every lead and counting client-side. Placed before
   GET /:id so Express doesn't try to treat "stats" as a lead id. */
router.get("/stats", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [byStatus, total, newToday, newThisWeek] = await Promise.all([
    prisma.lead.groupBy({ by: ["status"], where: { gymId }, _count: { _all: true } }),
    prisma.lead.count({ where: { gymId } }),
    prisma.lead.count({ where: { gymId, createdAt: { gte: startOfToday } } }),
    prisma.lead.count({ where: { gymId, createdAt: { gte: sevenDaysAgo } } }),
  ]);

  const statusCounts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0]));
  for (const row of byStatus) statusCounts[row.status] = row._count._all;

  const converted = statusCounts["Converted"] || 0;
  const lost = statusCounts["Lost"] || 0;
  // Conversion rate only counts leads that have actually been decided
  // either way (Converted or Lost) — a pile of fresh, untouched "New"
  // leads shouldn't drag the rate down just because no one's called
  // them yet.
  const decided = converted + lost;
  const conversionRate = decided > 0 ? Math.round((converted / decided) * 100) : null;

  res.json({
    total,
    newToday,
    newThisWeek,
    byStatus: statusCounts,
    conversionRate, // percent, or null if nothing's been decided yet
  });
});

/* ---------- GET /leads/export.csv ----------
   Downloadable CSV of every lead for this gym — the low-effort
   alternative to Google Sheets sync: no service-account setup, no
   external account needed, just a file the browser saves directly.
   Respects the same ?status=&search= filters as GET /leads, so "export
   just my New leads" works via the same query params. */
router.get("/export.csv", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const { status, search } = req.query;
  const where = { gymId };
  if (status) {
    if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ error: "Not a valid status." });
    where.status = status;
  }
  if (search && String(search).trim()) {
    const term = String(search).trim();
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { phone: { contains: term, mode: "insensitive" } },
      { email: { contains: term, mode: "insensitive" } },
    ];
  }

  const leads = await prisma.lead.findMany({ where, orderBy: { createdAt: "desc" } });

  const headers = ["Name", "Phone", "Email", "Goal", "Preferred Time", "Source", "Status", "Notes", "Created At", "Last Activity"];
  // Quote every field and double up any embedded quotes — the standard
  // CSV escaping rule — so a comma or quote inside a name/notes field
  // can't corrupt the column structure when opened in Excel/Sheets.
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = leads.map((l) => [
    l.name, l.phone, l.email, l.goal, l.preferredTime, l.source, l.status, l.notes,
    l.createdAt.toISOString(), l.lastActivityAt ? l.lastActivityAt.toISOString() : "",
  ].map(escape).join(","));

  const csv = [headers.map(escape).join(","), ...rows].join("\r\n");
  const filename = `leads-${new Date().toISOString().slice(0, 10)}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
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

/* ---------- PATCH /leads/bulk-status ----------
   Sets the same status on several leads in one call — e.g. selecting
   a batch of leads after a round of calls and marking them all
   "Contacted" at once, instead of one request per lead. Listed before
   GET/PATCH /:id so Express doesn't mistake "bulk-status" for an id.
   Body: { ids: string[], status: one of LEAD_STATUSES }
   Each lead gets the same statusHistory treatment as the single-lead
   PATCH /:id/status — appended, not overwritten — and ids that don't
   belong to this gym (wrong gym, typo, already deleted) are silently
   skipped rather than failing the whole batch; the response says how
   many actually matched. */
router.patch("/bulk-status", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const { ids, status } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "Expected a non-empty 'ids' array." });
  }
  if (ids.length > 500) {
    return res.status(400).json({ error: "Too many leads in one batch (max 500)." });
  }
  if (!LEAD_STATUSES.includes(status)) {
    return res.status(400).json({ error: "Not a valid status." });
  }

  // Scoped to this gym, same as every other route here — an id from
  // another gym (or a stale/mistyped one) just won't be in this list,
  // so it's naturally excluded rather than needing a separate check.
  const targets = await prisma.lead.findMany({ where: { gymId, id: { in: ids } } });
  const now = new Date().toISOString();

  await prisma.$transaction(
    targets.map((lead) =>
      prisma.lead.update({
        where: { id: lead.id },
        data: {
          status,
          statusHistory: [...(Array.isArray(lead.statusHistory) ? lead.statusHistory : []), { status, at: now }],
          lastActivityAt: new Date(),
        },
      })
    )
  );

  res.json({ ok: true, updated: targets.length, requested: ids.length });
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

/* ---------- POST /leads/sync-to-sheet ----------
   Pushes this gym's current leads into the Google Sheet they've
   configured (GymSettings.googleSheetId) — see services/googleSheets.js
   for the one-time setup. Overwrites rather than appends, so repeated
   clicks are safe and Status/Notes edits since the last sync show up. */
router.post("/sync-to-sheet", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const settings = await getGymSettings(gymId);
  const leads = await prisma.lead.findMany({ where: { gymId }, orderBy: { createdAt: "desc" } });

  const result = await syncLeadsToSheet(settings?.googleSheetId, leads);
  if (!result.ok) return res.status(400).json({ error: result.reason });
  res.json({ ok: true, rowCount: result.rowCount });
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
