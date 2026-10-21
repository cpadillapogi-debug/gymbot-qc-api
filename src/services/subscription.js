/* ============================================================
   GYMBOT QC API — SUBSCRIPTION SERVICE
   Server-side port of the frontend's js/services/subscription-service.js
   state machine. Same constants (pulled from js/config.js — not
   reinvented here), same transition rules, same derived-access shape.
   This is now the real source of truth for every gym that has a row in
   `subscriptions` — the frontend's localStorage copy only remains
   authoritative for the Developer sales-demo gym (DEMO_GYM_ID), which
   has no server row and never calls this API.

   FINANCIAL INTEGRITY: getAmountDue() is the ONLY place an amount owed
   is computed. It always derives from the gym's own stored planId —
   never from anything a client sends. billing.js's GCash submit/approve
   routes call this instead of trusting req.body.amount.
   ============================================================ */
import { prisma } from "../db.js";

/* ---------- Plans — mirrors SUBSCRIPTION_PLANS in frontend js/config.js ---------- */
export const PLANS = Object.freeze({
  starter: { id: "starter", name: "Starter", priceMonthly: 1500 },
  pro: { id: "pro", name: "Pro", priceMonthly: 2500 },
  elite: { id: "elite", name: "Elite", priceMonthly: 4000 },
});
export const DEFAULT_PLAN_ID = "pro";

export function getPlan(planId) {
  return PLANS[planId] || PLANS[DEFAULT_PLAN_ID];
}
export function getAllPlans() {
  return Object.values(PLANS);
}
export function isValidPlanId(planId) {
  return Object.prototype.hasOwnProperty.call(PLANS, planId);
}

/* ---------- Status enum — mirrors SUBSCRIPTION_STATUS in frontend js/config.js ---------- */
export const SUBSCRIPTION_STATUS = Object.freeze({
  TRIALING: "trialing",
  ACTIVE: "active",
  PENDING_PAYMENT: "pending_payment",
  GRACE_PERIOD: "grace_period",
  SUSPENDED: "suspended",
  DISABLED: "disabled",
  CANCELED: "canceled",
  EXPIRED: "expired",
});
const STATUS_VALUES = Object.values(SUBSCRIPTION_STATUS);
export function isValidStatus(status) {
  return STATUS_VALUES.includes(status);
}

/* ---------- Timers — mirrors the CONFIG.SUBSCRIPTION_* constants ---------- */
const TRIAL_DAYS = 14;
const BILLING_INTERVAL_DAYS = 30;
const GRACE_TRIGGER_DAYS = 3;
const GRACE_PERIOD_DAYS = 7;
const SUSPENSION_TRIGGER_DAYS = 14;
export const DEV_EXTEND_TRIAL_MAX_DAYS = 90;

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/* ---------- Default record + state machine ---------- */

function defaultRecordData(gymCreatedAt) {
  const anchor = gymCreatedAt || new Date();
  const trialEnd = addDays(anchor, TRIAL_DAYS);
  return {
    planId: DEFAULT_PLAN_ID,
    status: SUBSCRIPTION_STATUS.TRIALING,
    statusSince: anchor,
    trialEndDate: trialEnd,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    nextBillingDate: trialEnd,
    canceledAt: null,
    requestedPlanId: null,
    upgradeRequestedAt: null,
  };
}

/** Pure function: given a subscription-shaped record and "now", returns
 *  the patch for the next due transition, or null if nothing is due.
 *  Mirrors applyNextTransition() in the frontend 1:1. */
export function nextTransition(sub, now) {
  const sinceMs = new Date(sub.statusSince).getTime();
  const nowMs = now.getTime();

  switch (sub.status) {
    case SUBSCRIPTION_STATUS.TRIALING: {
      if (nowMs < new Date(sub.trialEndDate).getTime()) return null;
      const periodStart = sub.trialEndDate;
      const periodEnd = addDays(periodStart, BILLING_INTERVAL_DAYS);
      return {
        status: SUBSCRIPTION_STATUS.PENDING_PAYMENT,
        statusSince: periodStart,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextBillingDate: periodEnd,
      };
    }
    case SUBSCRIPTION_STATUS.PENDING_PAYMENT: {
      const graceAt = addDays(sinceMs, GRACE_TRIGGER_DAYS);
      if (nowMs < graceAt.getTime()) return null;
      return { status: SUBSCRIPTION_STATUS.GRACE_PERIOD, statusSince: graceAt };
    }
    case SUBSCRIPTION_STATUS.GRACE_PERIOD: {
      const suspendAt = addDays(sinceMs, GRACE_PERIOD_DAYS);
      if (nowMs < suspendAt.getTime()) return null;
      return { status: SUBSCRIPTION_STATUS.SUSPENDED, statusSince: suspendAt };
    }
    case SUBSCRIPTION_STATUS.SUSPENDED: {
      const disableAt = addDays(sinceMs, SUSPENSION_TRIGGER_DAYS);
      if (nowMs < disableAt.getTime()) return null;
      return { status: SUBSCRIPTION_STATUS.DISABLED, statusSince: disableAt };
    }
    case SUBSCRIPTION_STATUS.CANCELED: {
      if (!sub.currentPeriodEnd || nowMs < new Date(sub.currentPeriodEnd).getTime()) return null;
      return { status: SUBSCRIPTION_STATUS.EXPIRED, statusSince: sub.currentPeriodEnd };
    }
    default:
      return null; // ACTIVE / DISABLED / EXPIRED are terminal here — only a Developer action or fresh payment moves them.
  }
}

/** The only read path for a gym's subscription. Lazily creates a
 *  Trialing row on first call (anchored to the gym's own createdAt, so
 *  re-reading it later is deterministic), then advances it through any
 *  transitions already due (bounded loop) before returning it. */
export async function getSubscription(gymId) {
  if (!gymId) return null;

  let sub = await prisma.subscription.findUnique({ where: { gymId } });
  if (!sub) {
    const gym = await prisma.gym.findUnique({ where: { id: gymId } });
    if (!gym) return null;
    sub = await prisma.subscription.create({ data: { gymId, ...defaultRecordData(gym.createdAt) } });
  }

  const now = new Date();
  for (let guard = 0; guard < 10; guard++) {
    const patch = nextTransition(sub, now);
    if (!patch) break;
    sub = await prisma.subscription.update({ where: { gymId }, data: patch });
  }
  return sub;
}

/** Lets the caller choose the plan a brand-new trial starts on (used by
 *  the onboarding wizard's plan picker). Never overwrites an existing row. */
export async function startTrialWithPlan(gymId, planId) {
  if (!gymId) return null;
  const existing = await prisma.subscription.findUnique({ where: { gymId } });
  if (existing) return getSubscription(gymId);

  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) return null;
  const data = defaultRecordData(gym.createdAt);
  if (isValidPlanId(planId)) data.planId = planId;
  return prisma.subscription.create({ data: { gymId, ...data } });
}

/* ---------- Derived, display-only values ---------- */

/** @returns {{aiEnabled:boolean, dashboardReadOnly:boolean, accountLocked:boolean, banner:string|null}} */
export function getSubscriptionAccess(status) {
  switch (status) {
    case SUBSCRIPTION_STATUS.TRIALING:
      return { aiEnabled: true, dashboardReadOnly: false, accountLocked: false, banner: "trial" };
    case SUBSCRIPTION_STATUS.ACTIVE:
      return { aiEnabled: true, dashboardReadOnly: false, accountLocked: false, banner: null };
    case SUBSCRIPTION_STATUS.PENDING_PAYMENT:
      return { aiEnabled: true, dashboardReadOnly: false, accountLocked: false, banner: "payment_due" };
    case SUBSCRIPTION_STATUS.GRACE_PERIOD:
      return { aiEnabled: true, dashboardReadOnly: false, accountLocked: false, banner: "grace" };
    case SUBSCRIPTION_STATUS.SUSPENDED:
      return { aiEnabled: false, dashboardReadOnly: true, accountLocked: false, banner: "suspended" };
    case SUBSCRIPTION_STATUS.DISABLED:
      return { aiEnabled: false, dashboardReadOnly: true, accountLocked: true, banner: null };
    case SUBSCRIPTION_STATUS.CANCELED:
      return { aiEnabled: false, dashboardReadOnly: false, accountLocked: false, banner: "canceled" };
    case SUBSCRIPTION_STATUS.EXPIRED:
      return { aiEnabled: false, dashboardReadOnly: false, accountLocked: false, banner: "expired" };
    default:
      return { aiEnabled: true, dashboardReadOnly: false, accountLocked: false, banner: null };
  }
}

export function getTrialDaysRemaining(sub) {
  if (!sub || sub.status !== SUBSCRIPTION_STATUS.TRIALING) return 0;
  const ms = new Date(sub.trialEndDate).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

/** THE financial-integrity helper — the amount a gym currently owes,
 *  derived purely from its own stored subscription row. Never accepts
 *  or trusts a client-supplied amount. */
export function getAmountDue(sub) {
  if (!sub) return 0;
  const owedStatuses = [SUBSCRIPTION_STATUS.PENDING_PAYMENT, SUBSCRIPTION_STATUS.GRACE_PERIOD, SUBSCRIPTION_STATUS.SUSPENDED];
  return owedStatuses.includes(sub.status) ? getPlan(sub.planId).priceMonthly : 0;
}

/* ---------- Owner-facing actions ---------- */

/** Records an upgrade REQUEST only — never changes planId/price/status
 *  directly. There's no real payment gateway; an owner "upgrading" can
 *  only flag intent for a Developer to action via applyRequestedPlanUpgrade(). */
export async function requestPlanUpgrade(gymId, planId) {
  if (!gymId) return { ok: false, reason: "Missing gym." };
  if (!isValidPlanId(planId)) return { ok: false, reason: "Unknown plan." };

  const sub = await getSubscription(gymId);
  if (!sub) return { ok: false, reason: "Gym not found." };
  if (sub.planId === planId) return { ok: false, reason: `Already on the ${getPlan(planId).name} plan.` };

  const updated = await prisma.subscription.update({
    where: { gymId },
    data: { requestedPlanId: planId, upgradeRequestedAt: new Date() },
  });
  return { ok: true, message: `Upgrade to ${getPlan(planId).name} requested — a Developer will review and apply it.`, subscription: updated };
}

/* ---------- Developer-only overrides ----------
   Gating is requireRole("DEVELOPER") at the route layer, not here. Every
   one of these is audit-logged by the calling route, not by this file,
   so the route always has access to req.user for `performedById`. */

async function setStatusRaw(gymId, status, extra = {}) {
  const sub = await getSubscription(gymId);
  if (!sub) return null;
  const updated = await prisma.subscription.update({
    where: { gymId },
    data: { status, statusSince: new Date(), ...extra },
  });
  return { previousStatus: sub.status, updated };
}

export async function activateGymManually(gymId) {
  const now = new Date();
  const periodEnd = addDays(now, BILLING_INTERVAL_DAYS);
  return setStatusRaw(gymId, SUBSCRIPTION_STATUS.ACTIVE, {
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    nextBillingDate: periodEnd,
  });
}

export async function suspendGymManually(gymId) {
  return setStatusRaw(gymId, SUBSCRIPTION_STATUS.SUSPENDED);
}

export async function disableGymManually(gymId) {
  return setStatusRaw(gymId, SUBSCRIPTION_STATUS.DISABLED);
}

export async function reactivateSubscription(gymId) {
  const sub = await getSubscription(gymId);
  if (!sub) return null;
  const reactivatable = [SUBSCRIPTION_STATUS.SUSPENDED, SUBSCRIPTION_STATUS.DISABLED];
  if (!reactivatable.includes(sub.status)) {
    return { error: `Only Suspended or Disabled subscriptions can be reactivated (this one is currently ${sub.status}).` };
  }
  return activateGymManually(gymId);
}

export async function extendTrial(gymId, days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0 || n > DEV_EXTEND_TRIAL_MAX_DAYS) {
    return { error: `Enter a number of days between 1 and ${DEV_EXTEND_TRIAL_MAX_DAYS}.` };
  }
  const sub = await getSubscription(gymId);
  if (!sub) return null;
  if (sub.status !== SUBSCRIPTION_STATUS.TRIALING) {
    return { error: `Only a Trialing subscription has a trial to extend (this one is currently ${sub.status}).` };
  }
  const previousTrialEnd = sub.trialEndDate;
  const newTrialEnd = addDays(previousTrialEnd, n);
  const updated = await prisma.subscription.update({
    where: { gymId },
    data: { trialEndDate: newTrialEnd, nextBillingDate: newTrialEnd },
  });
  return { previousTrialEnd, newTrialEnd, updated };
}

export async function changeSubscriptionPlanDirect(gymId, planId) {
  if (!isValidPlanId(planId)) return { error: "Unknown plan." };
  const sub = await getSubscription(gymId);
  if (!sub) return null;
  if (sub.planId === planId) return { error: `Already on the ${getPlan(planId).name} plan.` };
  const previousPlanId = sub.planId;
  const updated = await prisma.subscription.update({
    where: { gymId },
    data: { planId, requestedPlanId: null, upgradeRequestedAt: null },
  });
  return { previousPlanId, updated };
}

export async function applyRequestedPlanUpgrade(gymId) {
  const sub = await getSubscription(gymId);
  if (!sub) return null;
  if (!sub.requestedPlanId) return { error: "This gym has no pending upgrade request." };
  const previousPlanId = sub.planId;
  const updated = await prisma.subscription.update({
    where: { gymId },
    data: { planId: sub.requestedPlanId, requestedPlanId: null, upgradeRequestedAt: null },
  });
  return { previousPlanId, updated };
}

export async function changeBillingDate(gymId, isoDate) {
  const parsed = new Date(isoDate);
  if (!isoDate || isNaN(parsed.getTime())) return { error: "Enter a valid date." };
  const sub = await getSubscription(gymId);
  if (!sub) return null;
  const previousDate = sub.nextBillingDate;
  const extra = { nextBillingDate: parsed };
  if (sub.currentPeriodEnd) extra.currentPeriodEnd = parsed;
  if (sub.status === SUBSCRIPTION_STATUS.TRIALING) extra.trialEndDate = parsed;
  const updated = await prisma.subscription.update({ where: { gymId }, data: extra });
  return { previousDate, updated };
}

export async function setSubscriptionStatusManually(gymId, status) {
  if (!isValidStatus(status)) return { error: "Unknown subscription status." };
  const sub = await getSubscription(gymId);
  if (!sub) return null;
  if (sub.status === status) return { error: `Already ${status}.` };
  const result = await setStatusRaw(gymId, status);
  return result;
}

/* ---------- GCash billing transitions (called from routes/billing.js) ---------- */

/** Owner-triggered: fires when a proof of payment is submitted. */
export async function markSubscriptionAwaitingVerification(gymId) {
  const sub = await getSubscription(gymId);
  if (!sub) return null;
  return prisma.subscription.update({ where: { gymId }, data: { status: SUBSCRIPTION_STATUS.PENDING_PAYMENT, statusSince: new Date() } });
}

/** Developer action: approves a submitted payment -> Active, fresh period. */
export async function approveGymPayment(gymId) {
  return activateGymManually(gymId);
}

/** Developer action: rejects a submitted payment -> back to Pending Payment. */
export async function rejectGymPayment(gymId) {
  return setStatusRaw(gymId, SUBSCRIPTION_STATUS.PENDING_PAYMENT);
}
