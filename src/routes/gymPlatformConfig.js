/* ============================================================
   GYMBOT QC API — OWNER-FACING GYM PLATFORM CONFIG ROUTES
   (business type, country, currency, language). gymId always comes
   from the verified session, never the URL/body.
   ============================================================ */
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { gymGate } from "../middleware/gymGate.js";
import {
  getGymPlatformConfig,
  saveGymPlatformConfig,
  BUSINESS_TYPE_IDS,
  COUNTRIES,
  CURRENCY_CODES,
  LANGUAGE_CODES,
} from "../services/gymPlatformConfig.js";

const router = Router();
router.use(requireAuth, gymGate());

function requireGymId(req, res) {
  if (!req.user.gymId) {
    res.status(403).json({ error: "This account has no gym associated with it." });
    return null;
  }
  return req.user.gymId;
}

/* ---------- GET /gym-platform-config/catalog — the valid option lists ---------- */
router.get("/catalog", (req, res) => {
  res.json({
    businessTypeIds: BUSINESS_TYPE_IDS,
    countries: Object.values(COUNTRIES),
    currencyCodes: CURRENCY_CODES,
    languageCodes: LANGUAGE_CODES,
  });
});

/* ---------- GET /gym-platform-config/me ---------- */
router.get("/me", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;
  const config = await getGymPlatformConfig(gymId);
  res.json({ config });
});

/* ---------- PUT /gym-platform-config/me ---------- */
router.put("/me", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;
  const result = await saveGymPlatformConfig(gymId, req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.reason });
  res.json({ ok: true, config: result.config });
});

export default router;
