import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

// Same boundary as leads.js: gymId always comes from the verified
// session (req.user), never from the URL/body — a Gym Owner can only
// ever reach their own gym's conversations.
router.use(requireAuth);

const MESSAGE_TEXT_MAX_LEN = 4000;
const HANDLED_BY_VALUES = ["ai", "staff"];
const STATUS_VALUES = ["open", "resolved"];
const ROLE_VALUES = ["customer", "bot", "staff"];

function requireGymId(req, res) {
  if (!req.user.gymId) {
    res.status(403).json({ error: "This account has no gym associated with it." });
    return null;
  }
  return req.user.gymId;
}

function clamp(str, max) {
  return String(str || "").slice(0, max);
}

function toApiConversation(convo) {
  return {
    id: convo.id,
    gymId: convo.gymId,
    leadId: convo.leadId,
    customerName: convo.customerName,
    customerPhone: convo.customerPhone,
    handledBy: convo.handledBy,
    status: convo.status,
    createdAt: convo.createdAt,
    updatedAt: convo.updatedAt,
    lastMessageAt: convo.lastMessageAt,
    // Only present when messages were included in the query (detail
    // view) — list view omits this to keep the inbox list endpoint
    // cheap (no need to pull every message just to render a list row).
    messages: convo.messages ? convo.messages.map(toApiMessage) : undefined,
  };
}

function toApiMessage(msg) {
  return { id: msg.id, conversationId: msg.conversationId, role: msg.role, text: msg.text, createdAt: msg.createdAt };
}

/* ---------- GET /conversations ----------
   Inbox list: this gym's conversations, most recently active first.
   Optional ?status=open|resolved filter for the inbox's status tabs. */
router.get("/", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const status = req.query.status;
  const where = { gymId, ...(STATUS_VALUES.includes(status) ? { status } : {}) };

  const conversations = await prisma.conversation.findMany({
    where,
    orderBy: { lastMessageAt: "desc" },
  });
  res.json({ conversations: conversations.map(toApiConversation) });
});

/* ---------- GET /conversations/:id ----------
   Full thread for the inbox's detail panel — includes every message,
   oldest first (reading order). */
router.get("/:id", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const convo = await prisma.conversation.findFirst({
    where: { id: req.params.id, gymId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!convo) return res.status(404).json({ error: "Conversation not found." });
  res.json({ conversation: toApiConversation(convo) });
});

/* ---------- POST /conversations ----------
   Starts a new thread. This is what the chat widget calls on a
   customer's first message — customerName/customerPhone are
   optional at this point (a lot of conversations start before any
   contact info is captured; captureLead() links a leadId in later
   via PATCH once/if that happens).
   @body {customerName?, customerPhone?, leadId?} */
router.post("/", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const f = req.body || {};
  let leadId = null;
  if (f.leadId) {
    // Validate the lead actually belongs to this gym — same
    // never-trust-the-client-id rule as everywhere else in this API.
    const lead = await prisma.lead.findFirst({ where: { id: f.leadId, gymId } });
    if (!lead) return res.status(400).json({ error: "That lead doesn't belong to this gym." });
    leadId = lead.id;
  }

  const convo = await prisma.conversation.create({
    data: {
      gymId,
      leadId,
      customerName: clamp(f.customerName || "", 120),
      customerPhone: clamp(f.customerPhone || "", 40),
    },
  });
  res.status(201).json({ conversation: toApiConversation(convo) });
});

/* ---------- POST /conversations/:id/messages ----------
   Appends one message to the thread and bumps lastMessageAt (what
   the inbox list sorts by), so a newly-active conversation floats to
   the top the same way an email inbox would.
   @body {role: "customer"|"bot"|"staff", text} */
router.post("/:id/messages", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const { role, text } = req.body || {};
  if (!ROLE_VALUES.includes(role)) {
    return res.status(400).json({ error: "Not a valid message role." });
  }
  const cleanText = clamp((text || "").trim(), MESSAGE_TEXT_MAX_LEN);
  if (!cleanText) {
    return res.status(400).json({ error: "Message text can't be empty." });
  }

  const convo = await prisma.conversation.findFirst({ where: { id: req.params.id, gymId } });
  if (!convo) return res.status(404).json({ error: "Conversation not found." });

  const now = new Date();
  const [message] = await prisma.$transaction([
    prisma.message.create({ data: { conversationId: convo.id, role, text: cleanText } }),
    prisma.conversation.update({ where: { id: convo.id }, data: { lastMessageAt: now } }),
  ]);
  res.status(201).json({ message: toApiMessage(message) });
});

/* ---------- PATCH /conversations/:id ----------
   Covers the inbox's "Take over conversation" / "Return to AI" and
   "Mark resolved" / "Reopen" actions, plus linking a lead after the
   fact (captureLead() may create/find the lead mid-conversation).
   @body {handledBy?, status?, leadId?, customerName?, customerPhone?} */
router.patch("/:id", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;

  const convo = await prisma.conversation.findFirst({ where: { id: req.params.id, gymId } });
  if (!convo) return res.status(404).json({ error: "Conversation not found." });

  const f = req.body || {};
  const data = {};

  if (f.handledBy !== undefined) {
    if (!HANDLED_BY_VALUES.includes(f.handledBy)) {
      return res.status(400).json({ error: "Not a valid handledBy value." });
    }
    data.handledBy = f.handledBy;
  }
  if (f.status !== undefined) {
    if (!STATUS_VALUES.includes(f.status)) {
      return res.status(400).json({ error: "Not a valid status." });
    }
    data.status = f.status;
  }
  if (f.customerName !== undefined) data.customerName = clamp(f.customerName, 120);
  if (f.customerPhone !== undefined) data.customerPhone = clamp(f.customerPhone, 40);
  if (f.leadId !== undefined) {
    if (f.leadId === null) {
      data.leadId = null;
    } else {
      const lead = await prisma.lead.findFirst({ where: { id: f.leadId, gymId } });
      if (!lead) return res.status(400).json({ error: "That lead doesn't belong to this gym." });
      data.leadId = lead.id;
    }
  }

  const updated = await prisma.conversation.update({ where: { id: convo.id }, data });
  res.json({ conversation: toApiConversation(updated) });
});

export default router;
