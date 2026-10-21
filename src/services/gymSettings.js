/* ============================================================
   GYMBOT QC API — GYM SETTINGS SERVICE
   Server-side port of js/services/gym-settings-service.js. Field names
   and defaults mirror DEFAULT_BUSINESS_SETTINGS in the frontend's
   js/config.js exactly — read that file again before touching this one
   if the two ever drift.
   ============================================================ */
import { prisma } from "../db.js";

const FIELD_MAX_LEN = 300; // BUSINESS_SETTINGS_FIELD_MAX_LEN
const WELCOME_MESSAGE_MAX_LEN = 600;
const DESCRIPTION_MAX_LEN = 600;
const FAQ_MAX_COUNT = 20;
const FAQ_FIELD_MAX_LEN = 500;

const SIMPLE_FIELDS = [
  "gymName",
  "logoFileName",
  "address",
  "contactNumber",
  "facebookUrl",
  "instagramUrl",
  "hours",
  "membershipFee",
  "walkInFee",
  "studentDiscount",
  "ptRate",
];

function clamp(str, max) {
  return String(str == null ? "" : str).trim().slice(0, max);
}

function yesNo(v) {
  return ["yes", "no", "unspecified"].includes(v) ? v : "unspecified";
}

function genId() {
  return `faq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeFaqs(faqs) {
  if (!Array.isArray(faqs)) return [];
  return faqs
    .slice(0, FAQ_MAX_COUNT)
    .map((item) => ({
      id: (item && item.id) || genId(),
      question: clamp(item && item.question, FAQ_FIELD_MAX_LEN),
      answer: clamp(item && item.answer, FAQ_FIELD_MAX_LEN),
    }))
    .filter((item) => item.question || item.answer);
}

/** Returns this gym's settings, lazily creating the default row on
 *  first read (mirrors getBusinessSettings()'s "always return a full
 *  record, never null" contract). */
export async function getGymSettings(gymId) {
  if (!gymId) return null;
  let settings = await prisma.gymSettings.findUnique({ where: { gymId } });
  if (!settings) {
    settings = await prisma.gymSettings.create({ data: { gymId } });
  }
  return settings;
}

/** Validates + clamps input and MERGES it over the gym's existing saved
 *  record (never the bare defaults) — a partial save must not blank out
 *  fields it didn't submit. */
export async function saveGymSettings(gymId, fields) {
  if (!gymId) return { ok: false, reason: "No gym is associated with this account." };
  const existing = await getGymSettings(gymId);
  const f = Object.assign({}, existing, fields || {});

  const data = {};
  for (const key of SIMPLE_FIELDS) data[key] = clamp(f[key], FIELD_MAX_LEN);
  data.parkingAvailable = yesNo(f.parkingAvailable);
  data.welcomeMessage = clamp(f.welcomeMessage, WELCOME_MESSAGE_MAX_LEN);
  data.faqs = sanitizeFaqs(f.faqs);
  data.description = clamp(f.description, DESCRIPTION_MAX_LEN);
  data.trainerAvailable = yesNo(f.trainerAvailable);
  data.freeTrialAvailable = yesNo(f.freeTrialAvailable);

  const updated = await prisma.gymSettings.upsert({
    where: { gymId },
    update: data,
    create: { gymId, ...data },
  });
  return { ok: true, settings: updated };
}

const PUBLIC_FIELDS = [
  ...SIMPLE_FIELDS,
  "parkingAvailable",
  "welcomeMessage",
  "description",
  "trainerAvailable",
  "freeTrialAvailable",
];

/** Explicit allow-list for the anonymous widget — never leaks row ids,
 *  gymId or timestamps. */
export function toPublicSettings(row) {
  if (!row) return null;
  const out = {};
  for (const k of PUBLIC_FIELDS) out[k] = row[k];
  out.faqs = Array.isArray(row.faqs)
    ? row.faqs.map((f) => ({ question: f.question, answer: f.answer }))
    : [];
  return out;
}
