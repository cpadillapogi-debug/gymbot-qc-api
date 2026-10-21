/* ============================================================
   GYMBOT QC API — OWNER-FACING GYM SETTINGS ROUTES
   gymId always comes from the verified session, never the URL/body.
   ============================================================ */
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { gymGate } from "../middleware/gymGate.js";
import { getGymSettings, saveGymSettings } from "../services/gymSettings.js";

const router = Router();
router.use(requireAuth, gymGate());

function requireGymId(req, res) {
  if (!req.user.gymId) {
    res.status(403).json({ error: "This account has no gym associated with it." });
    return null;
  }
  return req.user.gymId;
}

/* ---------- GET /gym-settings/me ---------- */
router.get("/me", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;
  const settings = await getGymSettings(gymId);
  res.json({ settings });
});

/* ---------- PUT /gym-settings/me ---------- */
router.put("/me", async (req, res) => {
  const gymId = requireGymId(req, res);
  if (!gymId) return;
  const result = await saveGymSettings(gymId, req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.reason });
  res.json({ ok: true, settings: result.settings });
});

export default router;
