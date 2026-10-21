import { test } from "node:test";
import assert from "node:assert/strict";
process.env.JWT_SECRET = "test-secret-not-real";
import { stubDb } from "./helpers.js";
stubDb();

const sub = await import("../src/services/subscription.js");
const settings = await import("../src/services/gymSettings.js");
const platform = await import("../src/services/gymPlatformConfig.js");
const { csrfHeaderGate } = await import("../src/middleware/csrf.js");
const { requireAuth, requireRole } = await import("../src/middleware/requireAuth.js");
const jwt = (await import("jsonwebtoken")).default;

const S = sub.SUBSCRIPTION_STATUS;
const day = 86400000;

function res() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

test("amount due is derived from the server-side plan, never client input", () => {
  assert.equal(sub.getAmountDue({ status: S.PENDING_PAYMENT, planId: "starter" }), 1500);
  assert.equal(sub.getAmountDue({ status: S.GRACE_PERIOD, planId: "pro" }), 2500);
  assert.equal(sub.getAmountDue({ status: S.SUSPENDED, planId: "elite" }), 4000);
  assert.equal(sub.getAmountDue({ status: S.ACTIVE, planId: "elite" }), 0);
  assert.equal(sub.getAmountDue(null), 0);
});

test("access matrix: suspended/disabled block AI and mutations", () => {
  assert.equal(sub.getSubscriptionAccess(S.SUSPENDED).dashboardReadOnly, true);
  assert.equal(sub.getSubscriptionAccess(S.SUSPENDED).aiEnabled, false);
  assert.equal(sub.getSubscriptionAccess(S.DISABLED).accountLocked, true);
  assert.equal(sub.getSubscriptionAccess(S.ACTIVE).aiEnabled, true);
  assert.equal(sub.getSubscriptionAccess(S.TRIALING).accountLocked, false);
});

test("state machine: trial -> pending -> grace -> suspended -> disabled", () => {
  const t0 = new Date("2026-01-01T00:00:00Z");
  let s = { status: S.TRIALING, statusSince: t0, trialEndDate: new Date(t0.getTime() + 14 * day) };
  assert.equal(sub.nextTransition(s, new Date(t0.getTime() + 1 * day)), null);
  const p = sub.nextTransition(s, new Date(t0.getTime() + 15 * day));
  assert.equal(p.status, S.PENDING_PAYMENT);
  s = { ...s, ...p };
  const g = sub.nextTransition(s, new Date(s.statusSince.getTime() + 60 * day));
  assert.equal(g.status, S.GRACE_PERIOD);
  const su = sub.nextTransition({ ...s, ...g }, new Date(g.statusSince.getTime() + 8 * day));
  assert.equal(su.status, S.SUSPENDED);
  const d = sub.nextTransition({ ...s, ...su }, new Date(su.statusSince.getTime() + 15 * day));
  assert.equal(d.status, S.DISABLED);
  assert.equal(sub.nextTransition({ status: S.DISABLED, statusSince: t0 }, new Date()), null);
  assert.equal(sub.nextTransition({ status: S.ACTIVE, statusSince: t0 }, new Date()), null);
});

test("public settings DTO is an allow-list", () => {
  const out = settings.toPublicSettings({
    id: "x", gymId: "g1", updatedAt: new Date(), gymName: "A", hours: "9-5",
    faqs: [{ id: "f", question: "q", answer: "a" }],
  });
  assert.equal(out.id, undefined);
  assert.equal(out.gymId, undefined);
  assert.equal(out.updatedAt, undefined);
  assert.equal(out.gymName, "A");
  assert.deepEqual(out.faqs, [{ question: "q", answer: "a" }]);
  assert.equal(settings.toPublicSettings(null), null);
});

test("platform config rejects unknown values server-side", async () => {
  for (const bad of [{ businessTypeId: "nope" }, { countryCode: "ZZ" }, { currencyCode: "XXX" }, { languageCode: "xx" }]) {
    const r = await platform.saveGymPlatformConfig("g1", bad);
    assert.equal(r.ok, false);
  }
  assert.equal((await platform.saveGymPlatformConfig("g1", { currencyCode: "USD" })).ok, true);
  assert.equal((await platform.saveGymPlatformConfig("", {})).ok, false);
});

test("csrf gate: mutations need header; public + health exempt", () => {
  const run = (method, path, header) => {
    let nexted = false;
    const r = res();
    csrfHeaderGate({ method, path, get: () => header }, r, () => { nexted = true; });
    return { nexted, code: r.code };
  };
  assert.equal(run("POST", "/leads", undefined).code, 403);
  assert.equal(run("POST", "/leads", "web").nexted, true);
  assert.equal(run("GET", "/leads", undefined).nexted, true);
  assert.equal(run("POST", "/public/g1/messages", undefined).nexted, true);
  assert.equal(run("POST", "/health", undefined).nexted, true);
});

test("requireAuth / requireRole", () => {
  let r = res();
  requireAuth({ cookies: {} }, r, () => assert.fail("should not pass"));
  assert.equal(r.code, 401);
  r = res();
  requireAuth({ cookies: { session: "garbage" } }, r, () => assert.fail("should not pass"));
  assert.equal(r.code, 401);
  const tok = jwt.sign({ userId: "u", role: "GYM_OWNER", gymId: "g1" }, process.env.JWT_SECRET);
  const req = { cookies: { session: tok } };
  let ok = false;
  requireAuth(req, res(), () => { ok = true; });
  assert.ok(ok);
  assert.equal(req.user.gymId, "g1");
  r = res();
  requireRole("DEVELOPER")(req, r, () => assert.fail("owner must not pass"));
  assert.equal(r.code, 403);
  let dev = false;
  requireRole("DEVELOPER", "GYM_OWNER")(req, res(), () => { dev = true; });
  assert.ok(dev);
});
