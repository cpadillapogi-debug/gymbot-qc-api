/* ============================================================
   GYMBOT QC API — GYM PLATFORM CONFIG SERVICE
   Server-side port of js/services/gym-config-service.js. Valid ID/code
   lists below are copied from the frontend's js/config-business-types.js
   and js/config-globalization.js — keep both in sync by hand if either
   catalog changes; this is the server-side validation boundary that
   file's own header flags as still-missing ("values validated
   server-side" — this is that validation).
   ============================================================ */
import { prisma } from "../db.js";

export const BUSINESS_TYPE_IDS = Object.freeze([
  "traditional_gym",
  "fitness_center",
  "boxing_gym",
  "martial_arts",
  "yoga_studio",
  "pilates_studio",
  "dance_studio",
  "personal_training",
  "sports_club",
  "wellness_center",
]);
export const DEFAULT_BUSINESS_TYPE_ID = "traditional_gym";

export const COUNTRIES = Object.freeze({
  PH: { code: "PH", defaultCurrency: "PHP", defaultLanguage: "fil" },
  US: { code: "US", defaultCurrency: "USD", defaultLanguage: "en" },
  GB: { code: "GB", defaultCurrency: "GBP", defaultLanguage: "en" },
  JP: { code: "JP", defaultCurrency: "JPY", defaultLanguage: "ja" },
  AE: { code: "AE", defaultCurrency: "AED", defaultLanguage: "ar" },
});
export const DEFAULT_COUNTRY_CODE = "PH";

export const CURRENCY_CODES = Object.freeze(["PHP", "USD", "GBP", "JPY", "AED", "SGD"]);
export const LANGUAGE_CODES = Object.freeze(["en", "fil", "ja", "ar"]);

function defaultData() {
  const country = COUNTRIES[DEFAULT_COUNTRY_CODE];
  return {
    businessTypeId: DEFAULT_BUSINESS_TYPE_ID,
    countryCode: country.code,
    currencyCode: country.defaultCurrency,
    languageCode: country.defaultLanguage,
  };
}

export async function getGymPlatformConfig(gymId) {
  if (!gymId) return null;
  let config = await prisma.gymPlatformConfig.findUnique({ where: { gymId } });
  if (!config) {
    config = await prisma.gymPlatformConfig.create({ data: { gymId, ...defaultData() } });
  }
  return config;
}

/** Validates every field against the real server-side catalogs above —
 *  an unknown businessTypeId/countryCode/currencyCode/languageCode is
 *  rejected outright rather than silently falling back, so a bad client
 *  payload never gets silently coerced into looking like it worked. */
export async function saveGymPlatformConfig(gymId, fields) {
  if (!gymId) return { ok: false, reason: "No gym is associated with this account." };
  const f = fields || {};
  // Ensures a row exists first (lazy-create, same as getGymPlatformConfig's
  // own contract) — by the time we reach the upsert below it always hits
  // the `update` branch; `create` is just a defensive fallback for a
  // race between two concurrent first-saves.
  await getGymPlatformConfig(gymId);

  const data = {};
  if (f.businessTypeId !== undefined) {
    if (!BUSINESS_TYPE_IDS.includes(f.businessTypeId)) {
      return { ok: false, reason: "Unknown business type." };
    }
    data.businessTypeId = f.businessTypeId;
  }
  if (f.countryCode !== undefined) {
    if (!COUNTRIES[f.countryCode]) return { ok: false, reason: "Unknown country." };
    data.countryCode = f.countryCode;
  }
  if (f.currencyCode !== undefined) {
    if (!CURRENCY_CODES.includes(f.currencyCode)) return { ok: false, reason: "Unknown currency." };
    data.currencyCode = f.currencyCode;
  }
  if (f.languageCode !== undefined) {
    if (!LANGUAGE_CODES.includes(f.languageCode)) return { ok: false, reason: "Unknown language." };
    data.languageCode = f.languageCode;
  }

  const updated = await prisma.gymPlatformConfig.upsert({
    where: { gymId },
    update: data,
    create: { gymId, ...Object.assign({}, defaultData(), data) },
  });
  return { ok: true, config: updated };
}
