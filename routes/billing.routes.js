// routes/billing.routes.js
import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";

import subscriptionModel from "../models/subscription.model.js";
import paymentOrderModel from "../models/paymentOrder.model.js";
import userModel from "../models/user.model.js";
import vendorFirmLinkModel from "../models/vendorFirmLink.model.js";

import { authorizeTokens } from "../middlewares/auth.middleware.js";
import {
  razorpay,
  verifyRazorpaySignature,
  verifyRazorpayWebhookSignature,
  getRazorpayKeyId,
} from "../lib/razorpay.js";

const billingRouter = express.Router();

/* ---------------- helpers ---------------- */

function getUserObjectId(req) {
  const raw = req?.user?._id || req?.user?.id || req?.user?.userId;
  if (!raw) return null;
  if (raw instanceof mongoose.Types.ObjectId) return raw;
  if (mongoose.isValidObjectId(String(raw))) return new mongoose.Types.ObjectId(String(raw));
  return null;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function daysRemaining(endAt) {
  const now = Date.now();
  const ms = new Date(endAt).getTime() - now;
  if (ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function prorationFactor(remainingDays, planDays) {
  const d = Math.max(1, toInt(planDays, remainingDays));
  const r = Math.max(1, toInt(remainingDays, 1));
  return r / d;
}

function makeRequestId() {
  // Always store a non-empty clientRequestId to avoid unique index collisions on "".
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

// ✅ Platform admin bypass (adapt to your user schema)
function isPlatformAdminUser(me) {
  if (!me) return false;
  if (me.isSuperAdmin === true || me.isPlatformAdmin === true) return true;
  const role = String(me.role || me.userType || me.type || "").toLowerCase();
  return ["superadmin", "platform_admin", "root_admin", "owner_admin"].includes(role);
}

// ✅ billing persona from your business rules
function billingPersona(me) {
  return me?.vendorCode ? "vendor" : "firm";
}

async function getSubscriptionOwner(req) {
  const userId = getUserObjectId(req);
  if (!userId) {
    return { userId: null, ownerId: null, firmId: null, me: null, isPlatformAdmin: false };
  }

  const me = await userModel
    .findById(userId, {
      firmId: 1,
      status: 1,
      vendorCode: 1,
      role: 1,
      userType: 1,
      type: 1,
      isSuperAdmin: 1,
      isPlatformAdmin: 1,
    })
    .lean();

  if (!me || Number(me.status) === 0) {
    return { userId, ownerId: null, firmId: null, me: null, isPlatformAdmin: false };
  }

  const isPlatformAdmin = isPlatformAdminUser(me);

  const firmId =
    me.firmId && mongoose.isValidObjectId(String(me.firmId))
      ? new mongoose.Types.ObjectId(String(me.firmId))
      : null;

  const ownerId = firmId || userId; // firm subscription owner is firmId
  return { userId, ownerId, firmId, me, isPlatformAdmin };
}

async function getActiveSubscription(ownerId, session) {
  const now = new Date();
  return subscriptionModel
    .findOne({ userId: ownerId, status: "active", endAt: { $gt: now } })
    .sort({ endAt: -1 })
    .session(session || null);
}

/**
 * Pricing model from env
 */
function getPricingConfig() {
  const currency = process.env.SUB_CURRENCY || "INR";

  const monthlyAmount = Number(process.env.SUB_PLAN_MONTHLY_AMOUNT || 99900);
  const monthlyDays = Number(process.env.SUB_PLAN_MONTHLY_DAYS || 30);

  const yearlyAmount = Number(process.env.SUB_PLAN_YEARLY_AMOUNT || 999900);
  const yearlyDays = Number(process.env.SUB_PLAN_YEARLY_DAYS || 365);

  // seat addon
  const seatAddonMonthly = Number(process.env.SUB_SEAT_ADDON_MONTHLY || 19900);
  const seatAddonYearly = Number(process.env.SUB_SEAT_ADDON_YEARLY || 199900);

  // connection addon
  const firmAddonMonthly = Number(process.env.SUB_FIRM_LINK_ADDON_MONTHLY || 9900);
  const firmAddonYearly = Number(process.env.SUB_FIRM_LINK_ADDON_YEARLY || 99900);

  const maxSeats = toInt(process.env.SUB_MAX_SEATS, 500);
  const maxFirms = toInt(process.env.SUB_MAX_FIRMS, 500);

  // defaults (you can tune these via env)
  const includedMonthlySeats = toInt(process.env.SUB_MONTHLY_INCLUDED_SEATS, 1);
  const includedMonthlyFirms = toInt(process.env.SUB_MONTHLY_INCLUDED_FIRMS, 1);

  const includedYearlySeats = toInt(process.env.SUB_YEARLY_INCLUDED_SEATS, 1);
  const includedYearlyFirms = toInt(process.env.SUB_YEARLY_INCLUDED_FIRMS, 1);

  const tierCsv = String(process.env.SUB_PLAN_TIERS || "1,5,10").trim();
  const tiers = tierCsv
    .split(",")
    .map((x) => toInt(x, 0))
    .filter((x) => x > 0)
    .slice(0, 8);

  return {
    currency,
    base: {
      monthly: { amount: monthlyAmount, days: monthlyDays },
      yearly: { amount: yearlyAmount, days: yearlyDays },
    },
    included: {
      monthly: { seats: includedMonthlySeats, firms: includedMonthlyFirms },
      yearly: { seats: includedYearlySeats, firms: includedYearlyFirms },
    },
    addon: {
      monthly: { seat: seatAddonMonthly, firm: firmAddonMonthly },
      yearly: { seat: seatAddonYearly, firm: firmAddonYearly },
    },
    limits: { maxSeats, maxFirms },
    tiers,
  };
}

/**
 * ✅ getPlans(mode)
 * mode:
 *  - "firm"   => firm pays seats only (connections irrelevant, firmLimit forced 1)
 *  - "vendor" => vendor pays base subscription only (seats forced 1 at signup; connection upgrades later)
 *  - "all"    => superset (used for activation/verification/webhook days lookup)
 */
function getPlans(mode = "all") {
  const cfg = getPricingConfig();

  const buildBase = (durationKey) => {
    const base = cfg.base[durationKey];
    const inc = cfg.included[durationKey];
    const add = cfg.addon[durationKey];

    if (mode === "firm") {
      return {
        plan: durationKey === "yearly" ? "yearly" : "monthly",
        duration: durationKey,
        amount: base.amount,
        days: base.days,
        currency: cfg.currency,
        includedSeats: inc.seats,
        includedFirms: 1,
        addonSeat: add.seat,
        addonFirm: 0,
      };
    }

    if (mode === "vendor") {
      return {
        plan: durationKey === "yearly" ? "yearly" : "monthly",
        duration: durationKey,
        amount: base.amount,
        days: base.days,
        currency: cfg.currency,
        includedSeats: 1,
        includedFirms: Math.max(1, inc.firms),
        addonSeat: 0,
        addonFirm: add.firm,
      };
    }

    // mode === "all" (legacy superset)
    return {
      plan: durationKey === "yearly" ? "yearly" : "monthly",
      duration: durationKey,
      amount: base.amount,
      days: base.days,
      currency: cfg.currency,
      includedSeats: inc.seats,
      includedFirms: inc.firms,
      addonSeat: add.seat,
      addonFirm: add.firm,
    };
  };

  const monthlyBase = buildBase("monthly");
  const yearlyBase = buildBase("yearly");

  const mkTier = (durationKey, tier) => {
    const base = cfg.base[durationKey];
    const inc = cfg.included[durationKey];
    const add = cfg.addon[durationKey];

    // Vendor should not see tiers at all
    if (mode === "vendor") return null;

    if (mode === "firm") {
      // tiers vary ONLY seats
      const includedSeats = clamp(tier, 1, cfg.limits.maxSeats);
      const extraSeatsIncluded = Math.max(0, includedSeats - inc.seats);
      const tierAmount = base.amount + extraSeatsIncluded * add.seat;

      return {
        plan: `${durationKey}_tier_${tier}`,
        duration: durationKey,
        amount: tierAmount,
        days: base.days,
        currency: cfg.currency,
        includedSeats,
        includedFirms: 1,
        addonSeat: add.seat,
        addonFirm: 0,
      };
    }

    // mode === "all"
    const includedSeats = clamp(tier, 1, cfg.limits.maxSeats);
    const includedFirms = clamp(tier, 1, cfg.limits.maxFirms);

    const extraSeatsIncluded = Math.max(0, includedSeats - inc.seats);
    const extraFirmsIncluded = Math.max(0, includedFirms - inc.firms);

    const tierAmount = base.amount + extraSeatsIncluded * add.seat + extraFirmsIncluded * add.firm;

    return {
      plan: `${durationKey}_tier_${tier}`,
      duration: durationKey,
      amount: tierAmount,
      days: base.days,
      currency: cfg.currency,
      includedSeats,
      includedFirms,
      addonSeat: add.seat,
      addonFirm: add.firm,
    };
  };

  const tierPlans =
    mode === "vendor"
      ? []
      : cfg.tiers
          .flatMap((t) => [mkTier("monthly", t), mkTier("yearly", t)])
          .filter(Boolean);

  const list = [monthlyBase, yearlyBase, ...tierPlans];

  const catalog = {};
  for (const p of list) catalog[p.plan] = p;

  return { catalog, list, cfg };
}

function computeFinalAmount(planObj, reqSeats, reqFirms, limits, mode = "all") {
  const isFirm = mode === "firm";
  const isVendor = mode === "vendor";

  // Firm can choose seats; vendor cannot
  const seats = isVendor
    ? 1
    : clamp(toInt(reqSeats, planObj.includedSeats || 1), 1, limits.maxSeats);

  // Firm never buys connections; vendor does not buy connections at signup
  const firms = isFirm
    ? 1
    : isVendor
      ? Math.max(1, toInt(planObj.includedFirms, 1))
      : clamp(toInt(reqFirms, planObj.includedFirms || 1), 1, limits.maxFirms);

  const includedSeats = toInt(planObj.includedSeats, 1);
  const includedFirms = toInt(planObj.includedFirms, 1);

  const extraSeats = Math.max(0, seats - includedSeats);
  const extraFirms = Math.max(0, firms - includedFirms);

  const addonSeat = toInt(planObj.addonSeat, 0);
  const addonFirm = toInt(planObj.addonFirm, 0);

  const addonsAmount = extraSeats * addonSeat + extraFirms * addonFirm;
  const finalAmount = toInt(planObj.amount, 0) + addonsAmount;

  return {
    seats,
    firms,
    includedSeats,
    includedFirms,
    extraSeats,
    extraFirms,
    addonSeat,
    addonFirm,
    addonsAmount,
    finalAmount,
  };
}

/* ===========================================================
   ✅ Transactions (optional)
   =========================================================== */

async function withOptionalTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    try {
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result;
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.includes("Transaction numbers are only allowed on a replica set") || msg.includes("replica set")) {
        return await fn(null);
      }
      throw e;
    }
  } finally {
    session.endSession();
  }
}

async function markPaymentOrderFailed({ orderId, paymentId }) {
  await paymentOrderModel.updateOne(
    { razorpayOrderId: String(orderId), status: { $ne: "paid" } },
    { $set: { status: "failed", razorpayPaymentId: paymentId || "" } }
  );
}

async function lockPaymentOrderPaid({ orderId, paymentId, signature }, session) {
  const id = String(orderId);

  const existingPaid = await paymentOrderModel
    .findOne({ razorpayOrderId: id, status: "paid" })
    .session(session || null);
  if (existingPaid) return existingPaid;

  const locked = await paymentOrderModel.findOneAndUpdate(
    { razorpayOrderId: id, status: "created" },
    {
      $set: {
        status: "paid",
        razorpayPaymentId: paymentId || "",
        ...(signature ? { razorpaySignature: signature } : {}),
      },
    },
    { new: true, session: session || undefined }
  );

  if (!locked) {
    return paymentOrderModel
      .findOne({ razorpayOrderId: id })
      .sort({ createdAt: -1 })
      .session(session || null);
  }

  return locked;
}

async function syncVendorLinksOnSubscriptionChange({ vendorCode, oldSubId, newSubId, newEndAt }, session) {
  if (!vendorCode) return;

  // Always set endAt for active ties (your model requires tie validity = subscription endAt)
  await vendorFirmLinkModel.updateMany(
    {
      vendorCode: String(vendorCode),
      status: "active",
    },
    { $set: { endAt: newEndAt } },
    { session: session || undefined }
  );

  // If links were previously stamped to old subscription, move them to new subscription id
  if (oldSubId && newSubId) {
    await vendorFirmLinkModel.updateMany(
      {
        vendorCode: String(vendorCode),
        status: "active",
        subscriptionId: oldSubId,
      },
      { $set: { subscriptionId: newSubId, endAt: newEndAt } },
      { session: session || undefined }
    );
  }
}

async function applyUpgradeIfNeeded(po, session) {
  if (!po) return { applied: false, reason: "no_payment_order" };
  if (po.kind !== "upgrade_seats" && po.kind !== "upgrade_connections") return { applied: false, reason: "not_upgrade" };
  if (po.status !== "paid") return { applied: false, reason: "not_paid" };
  if (po.applied === true) return { applied: false, reason: "already_applied" };

  const sub = po.subscriptionId
    ? await subscriptionModel.findById(po.subscriptionId).session(session || null)
    : null;

  const now = new Date();
  if (!sub || sub.status !== "active" || !sub.endAt || new Date(sub.endAt) <= now) {
    await paymentOrderModel.updateOne(
      { _id: po._id },
      { $set: { notes: { ...(po.notes || {}), warning: "Paid upgrade but subscription not active" } } },
      { session: session || undefined }
    );
    return { applied: false, reason: "subscription_not_active" };
  }

  const inc = {};
  if (po.kind === "upgrade_seats") {
    const delta = toInt(po.seats, 0);
    if (delta > 0) inc.seats = delta;
  }
  if (po.kind === "upgrade_connections") {
    const delta = toInt(po.firmCount, 0);
    if (delta > 0) inc.firmLimit = delta;
  }

  if (Object.keys(inc).length === 0) {
    await paymentOrderModel.updateOne(
      { _id: po._id },
      {
        $set: {
          applied: true,
          appliedAt: new Date(),
          notes: { ...(po.notes || {}), warning: "No delta to apply" },
        },
      },
      { session: session || undefined }
    );
    return { applied: true, reason: "no_delta" };
  }

  await subscriptionModel.updateOne({ _id: sub._id }, { $inc: inc }, { session: session || undefined });

  // If this was a connection purchase, optionally stamp the link used (if provided)
  if (po.kind === "upgrade_connections") {
    const linkId = po?.notes?.linkId;
    const vendorCode = po?.notes?.vendorCode;
    if (linkId && mongoose.isValidObjectId(String(linkId)) && vendorCode) {
      await vendorFirmLinkModel.updateOne(
        {
          _id: new mongoose.Types.ObjectId(String(linkId)),
          vendorCode: String(vendorCode),
          status: "active",
        },
        { $set: { subscriptionId: sub._id, endAt: sub.endAt } },
        { session: session || undefined }
      );
    }
  }

  await paymentOrderModel.updateOne(
    { _id: po._id, applied: false },
    { $set: { applied: true, appliedAt: new Date() } },
    { session: session || undefined }
  );

  return { applied: true, reason: "applied" };
}

/* ===========================================================
   ✅ PUBLIC webhook (NO AUTH)
   - Handles:
     - subscription purchase activation (subscriptions.orderId)
     - upgrades (payment_orders.razorpayOrderId)
   =========================================================== */

billingRouter.post("/webhook/razorpay", async (req, res, next) => {
  try {
    const sig = req.headers["x-razorpay-signature"];
    const okSig = verifyRazorpayWebhookSignature({
      rawBody: req.rawBody,
      signature: sig,
    });

    if (!okSig) {
      return res.status(400).json({ ok: false, message: "Invalid webhook signature" });
    }

    const event = req.body?.event;
    if (event !== "payment.captured" && event !== "order.paid" && event !== "payment.failed") {
      return res.status(200).json({ ok: true });
    }

    const payment = req.body?.payload?.payment?.entity;
    const order = req.body?.payload?.order?.entity;

    const orderId = order?.id || payment?.order_id;
    const paymentId = payment?.id || "";

    if (!orderId) return res.status(200).json({ ok: true, message: "No orderId in webhook" });

    // 1) payment_orders path (upgrades / audit)
    const poExisting = await paymentOrderModel
      .findOne({ razorpayOrderId: String(orderId) })
      .sort({ createdAt: -1 });

    if (poExisting) {
      if (event === "payment.failed") {
        await markPaymentOrderFailed({ orderId, paymentId });
        return res.status(200).json({ ok: true });
      }

      await withOptionalTransaction(async (session) => {
        const po = await lockPaymentOrderPaid({ orderId, paymentId, signature: "" }, session);
        await applyUpgradeIfNeeded(po, session);
      });

      // if it was an upgrade, stop here
      if (poExisting.kind === "upgrade_seats" || poExisting.kind === "upgrade_connections") {
        return res.status(200).json({ ok: true, message: "Upgrade processed" });
      }
      // else subscription_new continues to subscription activation
    }

    // 2) subscriptions activation
    const pending = await subscriptionModel
      .findOne({ orderId: String(orderId) })
      .sort({ createdAt: -1 });

    if (!pending) return res.status(200).json({ ok: true, message: "No matching subscription/order found" });
    if (pending.status === "active") return res.status(200).json({ ok: true, message: "Already active" });

    if (event === "payment.failed") {
      pending.status = "failed";
      pending.paymentId = paymentId;
      await pending.save();
      await markPaymentOrderFailed({ orderId, paymentId });
      return res.status(200).json({ ok: true });
    }

    // ✅ Use superset catalog for day lookup
    const { catalog } = getPlans("all");
    const chosen = catalog[pending.plan] || catalog.monthly;

    const now = new Date();
    const existingActive = await subscriptionModel
      .findOne({ userId: pending.userId, status: "active", endAt: { $gt: now } })
      .sort({ endAt: -1 });

    const startAt = existingActive?.endAt ? new Date(existingActive.endAt) : now;
    const endAt = addDays(startAt, Number(chosen.days || 30));

    // ✅ carry over capacity so vendor connection purchases don't reset on renewal
    if (existingActive) {
      pending.seats = Math.max(toInt(pending.seats, 1), toInt(existingActive.seats, 1));
      pending.firmLimit = Math.max(toInt(pending.firmLimit, 1), toInt(existingActive.firmLimit, 1));

      existingActive.status = "expired";
      await existingActive.save();
    }

    pending.status = "active";
    pending.paymentId = paymentId;
    pending.startAt = startAt;
    pending.endAt = endAt;
    await pending.save();

    // Keep payment_orders in sync if exists (subscription_new audit)
    await paymentOrderModel.updateOne(
      { razorpayOrderId: String(orderId), status: "created" },
      { $set: { status: "paid", razorpayPaymentId: paymentId || "" } }
    );

    // ✅ vendor link validity sync (public webhook has no req.user, so lookup vendorCode)
    const u = await userModel.findById(pending.userId, { vendorCode: 1 }).lean();
    if (u?.vendorCode) {
      await withOptionalTransaction(async (session) => {
        await syncVendorLinksOnSubscriptionChange({
          vendorCode: u.vendorCode,
          oldSubId: existingActive?._id || null,
          newSubId: pending._id,
          newEndAt: pending.endAt,
        }, session);
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ===========================================================
   ✅ Everything below requires login
   =========================================================== */

billingRouter.use(authorizeTokens);

/**
 * GET /api/billing/plans
 * - firm: show seat pricing (and tiers if configured)
 * - vendor: show ONLY monthly/yearly base subscription
 */
billingRouter.get("/plans", async (req, res, next) => {
  try {
    const { me } = await getSubscriptionOwner(req);
    if (!me) return res.status(401).json({ message: "Unauthorized" });

    const mode = billingPersona(me); // "firm" | "vendor"
    const { list, cfg } = getPlans(mode);

    res.json({
      ok: true,
      keyId: getRazorpayKeyId(),
      mode,
      plans: list,
      pricing: {
        currency: cfg.currency,
        addon: cfg.addon,
        included: cfg.included,
        limits: cfg.limits,
        tiers: cfg.tiers,
      },
      uiHints:
        mode === "vendor"
          ? {
              note: "Vendors buy basic subscription to use app. Connections are purchased only after linking with a firm.",
              signupAllowsSeats: false,
              signupAllowsConnections: false,
            }
          : {
              note: "Firms pay for seats. Connection limits are not charged on firm side.",
              signupAllowsSeats: true,
              signupAllowsConnections: false,
            },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/billing/status
 * ✅ platform admin bypass => never blocked
 */
billingRouter.get("/status", async (req, res, next) => {
  try {
    const { ownerId, me, isPlatformAdmin } = await getSubscriptionOwner(req);
    if (!ownerId || !me) return res.status(401).json({ message: "Unauthorized" });

    if (isPlatformAdmin) {
      return res.json({
        ok: true,
        active: true,
        bypass: true,
        serverTime: new Date(),
        subscriptionOwnerId: ownerId,
        subscription: null,
      });
    }

    const now = new Date();

    const active = await subscriptionModel
      .findOne({ userId: ownerId, status: "active", endAt: { $gt: now } })
      .sort({ endAt: -1 })
      .lean();

    const last = await subscriptionModel
      .findOne({ userId: ownerId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      ok: true,
      active: Boolean(active),
      serverTime: now,
      subscriptionOwnerId: ownerId,
      subscription: active || last || null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/billing/order
 * ✅ Creates subscription pending + creates payment_orders audit
 * Business rules enforced:
 *  - Firm: pays seats only; firmLimit forced to 1
 *  - Vendor: can only buy monthly/yearly base subscription; seats forced to 1; firmLimit set to included (usually 1)
 */
billingRouter.post("/order", async (req, res, next) => {
  try {
    const { userId, ownerId, firmId, me, isPlatformAdmin } = await getSubscriptionOwner(req);
    if (!userId || !ownerId || !me) return res.status(401).json({ message: "Unauthorized" });

    if (isPlatformAdmin) {
      return res.status(403).json({ message: "Platform admin does not require subscription purchase." });
    }

    // seat users can't purchase subscription for firm
    if (firmId && String(userId) !== String(ownerId)) {
      return res.status(403).json({ message: "Seat users cannot purchase subscription. Contact firm admin." });
    }

    const mode = billingPersona(me); // "firm" | "vendor"

    const { plan, seats, firms, connections, clientRequestId } = req.body || {};

    // enforce vendor plan selection
    if (mode === "vendor") {
      const pid = String(plan || "monthly").toLowerCase();
      if (pid !== "monthly" && pid !== "yearly") {
        return res.status(400).json({ message: "Vendors can only purchase monthly/yearly base subscription." });
      }
    }

    const { catalog, cfg } = getPlans(mode);
    const chosen = catalog[String(plan || "monthly")] || catalog.monthly;
    if (!chosen) return res.status(400).json({ message: "Invalid plan" });

    const calc = computeFinalAmount(chosen, seats, firms ?? connections, cfg.limits, mode);

    // hard enforce field meanings by persona
    const finalSeats = mode === "vendor" ? 1 : calc.seats;
    const finalFirmLimit = mode === "firm" ? 1 : calc.firms;

    const uid = String(ownerId);
    const receipt = `sub_${uid.slice(-8)}_${String(Date.now()).slice(-10)}`;

    const reqId = clientRequestId ? String(clientRequestId) : makeRequestId();

    // idempotency (only meaningful when client sends the same clientRequestId)
    if (clientRequestId) {
      const existing = await paymentOrderModel.findOne({
        billingOwnerId: ownerId,
        kind: "subscription_new",
        clientRequestId: reqId,
      });

      if (existing && existing.status === "created") {
        return res.json({
          ok: true,
          keyId: getRazorpayKeyId(),
          order: {
            id: existing.razorpayOrderId,
            amount: existing.amount,
            currency: existing.currency,
            receipt: existing.receipt,
          },
          subscriptionId: existing.subscriptionId || null,
          plan: existing.planId,
          days: chosen.days,
          mode,
          seats: existing.seats,
          firms: existing.firmCount,
          deduped: true,
        });
      }
    }

    const rzpOrder = await razorpay.orders.create({
      amount: calc.finalAmount,
      currency: chosen.currency,
      receipt,
      notes: {
        userId: uid,
        plan: chosen.plan,
        mode,
        seats: String(finalSeats),
        firmLimit: String(finalFirmLimit),
        baseAmount: String(chosen.amount),
        addonsAmount: String(calc.addonsAmount),
      },
    });

    const pending = await subscriptionModel.create({
      userId: ownerId,
      plan: chosen.plan,
      status: "pending",
      orderId: rzpOrder.id,
      amount: calc.finalAmount,
      currency: chosen.currency,
      seats: finalSeats,
      firmLimit: finalFirmLimit,
      notes: {
        receipt,
        mode,
        pricing: {
          baseAmount: chosen.amount,
          addonsAmount: calc.addonsAmount,
          finalAmount: calc.finalAmount,
          includedSeats: calc.includedSeats,
          includedFirms: calc.includedFirms,
          extraSeats: calc.extraSeats,
          extraFirms: calc.extraFirms,
          addonSeat: calc.addonSeat,
          addonFirm: calc.addonFirm,
        },
      },
    });

    await paymentOrderModel.create({
      billingOwnerId: ownerId,
      createdByUserId: userId,
      userId: ownerId,

      kind: "subscription_new",
      subscriptionId: pending._id,
      planId: chosen.plan,

      // subscription_new => TOTALS
      seats: finalSeats,
      firmCount: finalFirmLimit,
      vendorLinkCount: 0,

      targetSeats: finalSeats,
      targetFirmCount: finalFirmLimit,

      baseAmount: chosen.amount,
      addonsAmount: calc.addonsAmount,

      amount: calc.finalAmount,
      currency: chosen.currency,

      receipt,
      razorpayOrderId: rzpOrder.id,

      clientRequestId: reqId,
      notes: {
        mode,
        subscriptionOrderId: rzpOrder.id,
      },
    });

    return res.json({
      ok: true,
      keyId: getRazorpayKeyId(),
      order: {
        id: rzpOrder.id,
        amount: rzpOrder.amount,
        currency: rzpOrder.currency,
        receipt: rzpOrder.receipt,
      },
      subscriptionId: pending._id,
      plan: chosen.plan,
      days: chosen.days,
      mode,
      seats: finalSeats,
      firms: finalFirmLimit,
      breakdown: {
        baseAmount: chosen.amount,
        addonsAmount: calc.addonsAmount,
        finalAmount: calc.finalAmount,
      },
    });
  } catch (err) {
    const rp = err?.error;
    if (rp?.description) return res.status(400).json({ message: rp.description, razorpay: rp });
    next(err);
  }
});

/**
 * POST /api/billing/verify
 * ✅ Marks subscription active + marks payment_orders paid/failed
 * ✅ Carries over capacity on renewal (firm seats, vendor firmLimit) to avoid reset
 * ✅ Sync vendor links endAt to subscription endAt
 */
billingRouter.post("/verify", async (req, res, next) => {
  try {
    const { ownerId, me, isPlatformAdmin } = await getSubscriptionOwner(req);
    if (!ownerId || !me) return res.status(401).json({ message: "Unauthorized" });
    if (isPlatformAdmin) return res.status(403).json({ message: "Platform admin does not require subscription." });

    const { orderId, paymentId, signature } = req.body || {};
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ message: "orderId, paymentId, signature are required" });
    }

    const pending = await subscriptionModel.findOne({ orderId: String(orderId) }).sort({ createdAt: -1 });
    if (!pending) return res.status(404).json({ message: "Subscription order not found" });
    if (String(pending.userId) !== String(ownerId)) return res.status(403).json({ message: "Not allowed to verify this order" });

    if (pending.status === "active") {
      return res.json({ ok: true, message: "Already active", subscription: pending, active: true });
    }

    const ok = verifyRazorpaySignature({ orderId, paymentId, signature });
    if (!ok) {
      pending.status = "failed";
      await pending.save();

      await paymentOrderModel.updateOne(
        { razorpayOrderId: String(orderId), status: { $ne: "paid" } },
        { $set: { status: "failed", razorpayPaymentId: paymentId, razorpaySignature: signature } }
      );

      return res.status(400).json({ message: "Invalid payment signature" });
    }

    const { catalog } = getPlans("all");
    const chosen = catalog[pending.plan] || catalog.monthly;

    const now = new Date();
    const existingActive = await subscriptionModel
      .findOne({ userId: pending.userId, status: "active", endAt: { $gt: now } })
      .sort({ endAt: -1 });

    const startAt = existingActive?.endAt ? new Date(existingActive.endAt) : now;
    const endAt = addDays(startAt, Number(chosen.days || 30));

    if (existingActive) {
      // ✅ carry over capacity so upgrades persist across renewals
      pending.seats = Math.max(toInt(pending.seats, 1), toInt(existingActive.seats, 1));
      pending.firmLimit = Math.max(toInt(pending.firmLimit, 1), toInt(existingActive.firmLimit, 1));

      existingActive.status = "expired";
      await existingActive.save();
    }

    pending.status = "active";
    pending.paymentId = paymentId;
    pending.signature = signature;
    pending.startAt = startAt;
    pending.endAt = endAt;
    await pending.save();

    await paymentOrderModel.updateOne(
      { razorpayOrderId: String(orderId) },
      { $set: { status: "paid", razorpayPaymentId: paymentId, razorpaySignature: signature } }
    );

    // ✅ Vendor link sync (if vendor)
    if (me?.vendorCode) {
      await withOptionalTransaction(async (session) => {
        await syncVendorLinksOnSubscriptionChange({
          vendorCode: me.vendorCode,
          oldSubId: existingActive?._id || null,
          newSubId: pending._id,
          newEndAt: pending.endAt,
        }, session);
      });
    }

    return res.json({ ok: true, message: "Subscription activated", subscription: pending, active: true });
  } catch (err) {
    next(err);
  }
});

/* ===========================================================
   ✅ Firm add seats (same subscription)
   =========================================================== */

/**
 * POST /api/billing/firm/add-seats/order
 * body: { addSeats: number, clientRequestId?: string }
 */
billingRouter.post("/firm/add-seats/order", async (req, res, next) => {
  try {
    const { userId, ownerId, firmId, me, isPlatformAdmin } = await getSubscriptionOwner(req);
    if (!userId || !ownerId || !me) return res.status(401).json({ message: "Unauthorized" });
    if (isPlatformAdmin) return res.status(403).json({ message: "Platform admin does not need seats upgrade." });

    if (firmId && String(userId) !== String(ownerId)) {
      return res.status(403).json({ message: "Seat users cannot upgrade seats. Contact firm admin." });
    }
    if (me.vendorCode) return res.status(403).json({ message: "Vendors cannot use firm add-seats API" });

    const { addSeats, clientRequestId } = req.body || {};
    const cfgBase = getPricingConfig();
    const add = clamp(toInt(addSeats, 0), 1, cfgBase.limits.maxSeats);

    const active = await getActiveSubscription(ownerId);
    if (!active) return res.status(402).json({ message: "No active subscription to upgrade" });

    const { catalog, cfg } = getPlans("firm");
    const planObj = catalog[String(active.plan)] || catalog.monthly;

    const currentSeats = toInt(active.seats, 1);
    const targetSeats = currentSeats + add;
    if (targetSeats > cfg.limits.maxSeats) {
      return res.status(400).json({ message: `Max seats limit is ${cfg.limits.maxSeats}` });
    }

    const remaining = daysRemaining(active.endAt);
    if (!remaining) return res.status(400).json({ message: "Subscription expired" });

    const factor = prorationFactor(remaining, planObj.days);
    const unitSeat = toInt(planObj.addonSeat, 0);

    const addonsAmount = Math.ceil(unitSeat * add * factor);
    const amount = Math.max(100, addonsAmount);

    const uid = String(ownerId);
    const receipt = `upS_${uid.slice(-8)}_${String(Date.now()).slice(-10)}`;

    const reqId = clientRequestId ? String(clientRequestId) : makeRequestId();

    if (clientRequestId) {
      const existing = await paymentOrderModel.findOne({
        billingOwnerId: ownerId,
        kind: "upgrade_seats",
        clientRequestId: reqId,
      });
      if (existing && existing.status === "created") {
        return res.json({
          ok: true,
          keyId: getRazorpayKeyId(),
          order: { id: existing.razorpayOrderId, amount: existing.amount, currency: existing.currency, receipt: existing.receipt },
          upgrade: { addSeats: add, targetSeats },
          deduped: true,
        });
      }
    }

    const rzpOrder = await razorpay.orders.create({
      amount,
      currency: planObj.currency,
      receipt,
      notes: {
        userId: uid,
        kind: "upgrade_seats",
        subscriptionId: String(active._id),
        addSeats: String(add),
        targetSeats: String(targetSeats),
        remainingDays: String(remaining),
      },
    });

    await paymentOrderModel.create({
      billingOwnerId: ownerId,
      createdByUserId: userId,
      userId: ownerId,

      kind: "upgrade_seats",
      subscriptionId: active._id,
      planId: String(active.plan),

      // upgrades => DELTAS
      seats: add,
      firmCount: 0,
      vendorLinkCount: 0,

      targetSeats,
      targetFirmCount: 0,

      baseAmount: 0,
      addonsAmount,
      amount,
      currency: planObj.currency,

      receipt,
      razorpayOrderId: rzpOrder.id,
      clientRequestId: reqId,
      notes: { remainingDays: remaining, prorationFactor: factor },
    });

    return res.json({
      ok: true,
      keyId: getRazorpayKeyId(),
      order: { id: rzpOrder.id, amount: rzpOrder.amount, currency: rzpOrder.currency, receipt: rzpOrder.receipt },
      upgrade: { addSeats: add, targetSeats, remainingDays: remaining },
      breakdown: { unitSeat, addonsAmount, amount },
    });
  } catch (err) {
    const rp = err?.error;
    if (rp?.description) return res.status(400).json({ message: rp.description, razorpay: rp });
    next(err);
  }
});

/**
 * POST /api/billing/firm/add-seats/verify
 * body: { orderId, paymentId, signature }
 */
billingRouter.post("/firm/add-seats/verify", async (req, res, next) => {
  try {
    const { ownerId, me } = await getSubscriptionOwner(req);
    if (!ownerId || !me) return res.status(401).json({ message: "Unauthorized" });
    if (me.vendorCode) return res.status(403).json({ message: "Vendors cannot use firm add-seats API" });

    const { orderId, paymentId, signature } = req.body || {};
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ message: "orderId, paymentId, signature are required" });
    }

    const ok = verifyRazorpaySignature({ orderId, paymentId, signature });
    if (!ok) {
      await markPaymentOrderFailed({ orderId, paymentId });
      return res.status(400).json({ message: "Invalid payment signature" });
    }

    await withOptionalTransaction(async (session) => {
      const po = await lockPaymentOrderPaid({ orderId, paymentId, signature }, session);
      if (!po) throw new Error("Upgrade order not found");
      if (String(po.billingOwnerId) !== String(ownerId)) throw new Error("Not allowed");
      await applyUpgradeIfNeeded(po, session);
    });

    const po = await paymentOrderModel.findOne({ razorpayOrderId: String(orderId) }).lean();
    const sub = po?.subscriptionId ? await subscriptionModel.findById(po.subscriptionId).lean() : null;

    return res.json({ ok: true, message: "Seats upgrade processed", subscription: sub });
  } catch (err) {
    if (String(err?.message || "").includes("not found")) return res.status(404).json({ message: "Upgrade order not found" });
    if (String(err?.message || "").includes("Not allowed")) return res.status(403).json({ message: "Not allowed" });
    next(err);
  }
});

/* ===========================================================
   ✅ Vendor add connections (firmLimit) (same subscription)
   - Must have ACTIVE link (pay only after connection)
   =========================================================== */

billingRouter.post("/vendor/add-connections/order", async (req, res, next) => {
  try {
    const { userId, ownerId, me } = await getSubscriptionOwner(req);
    if (!userId || !ownerId || !me) return res.status(401).json({ message: "Unauthorized" });
    if (!me.vendorCode) return res.status(403).json({ message: "Firms cannot use vendor add-connections API" });

    const { linkId, firmId, addConnections, clientRequestId } = req.body || {};
    const active = await getActiveSubscription(ownerId);
    if (!active) return res.status(402).json({ message: "No active subscription to upgrade" });

    const now = new Date();

    // ✅ link must be active
    let link = null;
    if (linkId) {
      if (!mongoose.isValidObjectId(String(linkId))) return res.status(400).json({ message: "Invalid linkId" });
      link = await vendorFirmLinkModel.findOne({
        _id: new mongoose.Types.ObjectId(String(linkId)),
        vendorCode: String(me.vendorCode),
        status: "active",
        $or: [{ endAt: null }, { endAt: { $gt: now } }],
      });
    } else if (firmId) {
      if (!mongoose.isValidObjectId(String(firmId))) return res.status(400).json({ message: "Invalid firmId" });
      link = await vendorFirmLinkModel
        .findOne({
          firmId: new mongoose.Types.ObjectId(String(firmId)),
          vendorCode: String(me.vendorCode),
          status: "active",
          $or: [{ endAt: null }, { endAt: { $gt: now } }],
        })
        .sort({ createdAt: -1 });
    } else {
      return res.status(400).json({ message: "linkId (recommended) or firmId is required" });
    }

    if (!link) {
      return res.status(400).json({
        message: "No ACTIVE firm-vendor link found (or link expired). Pay only after successful connection.",
      });
    }

    // current active links count
    const activeLinksCount = await vendorFirmLinkModel.countDocuments({
      vendorCode: String(me.vendorCode),
      status: "active",
      $or: [{ endAt: null }, { endAt: { $gt: now } }],
    });

    const currentLimit = Math.max(1, toInt(active.firmLimit, 1));
    const requiredExtra = Math.max(0, activeLinksCount - currentLimit);

    const cfgBase = getPricingConfig();
    let delta = clamp(toInt(addConnections, 0), 0, cfgBase.limits.maxFirms);

    // auto required extra (or enforce at least required extra)
    if (!delta) delta = requiredExtra;
    else delta = Math.max(delta, requiredExtra);

    if (delta === 0) {
      return res.json({
        ok: true,
        noPaymentRequired: true,
        message: "No extra connections required. Current limit covers all active links.",
        stats: { activeLinksCount, firmLimit: currentLimit },
        linkId: String(link._id),
      });
    }

    const { catalog, cfg } = getPlans("vendor");
    const planObj = catalog[String(active.plan)] || catalog.monthly;

    const targetFirmCount = currentLimit + delta;
    if (targetFirmCount > cfg.limits.maxFirms) {
      return res.status(400).json({ message: `Max connections limit is ${cfg.limits.maxFirms}` });
    }

    const remaining = daysRemaining(active.endAt);
    if (!remaining) return res.status(400).json({ message: "Subscription expired" });

    const factor = prorationFactor(remaining, planObj.days);
    const unitFirm = toInt(planObj.addonFirm, 0);

    const addonsAmount = Math.ceil(unitFirm * delta * factor);
    const amount = Math.max(100, addonsAmount);

    const uid = String(ownerId);
    const receipt = `upC_${uid.slice(-8)}_${String(Date.now()).slice(-10)}`;

    const reqId = clientRequestId ? String(clientRequestId) : makeRequestId();

    if (clientRequestId) {
      const existing = await paymentOrderModel.findOne({
        billingOwnerId: ownerId,
        kind: "upgrade_connections",
        clientRequestId: reqId,
      });
      if (existing && existing.status === "created") {
        return res.json({
          ok: true,
          keyId: getRazorpayKeyId(),
          order: { id: existing.razorpayOrderId, amount: existing.amount, currency: existing.currency, receipt: existing.receipt },
          upgrade: {
            purchasedConnections: delta,
            requiredExtraConnections: requiredExtra,
            activeLinksCount,
            firmLimitBefore: currentLimit,
            targetFirmCount,
          },
          linkId: String(link._id),
          deduped: true,
        });
      }
    }

    const rzpOrder = await razorpay.orders.create({
      amount,
      currency: planObj.currency,
      receipt,
      notes: {
        userId: uid,
        kind: "upgrade_connections",
        subscriptionId: String(active._id),
        vendorCode: String(me.vendorCode),
        linkId: String(link._id),
        firmId: String(link.firmId),
        deltaConnections: String(delta),
        requiredExtraConnections: String(requiredExtra),
        activeLinksCount: String(activeLinksCount),
        firmLimitBefore: String(currentLimit),
        targetFirmCount: String(targetFirmCount),
        remainingDays: String(remaining),
      },
    });

    await paymentOrderModel.create({
      billingOwnerId: ownerId,
      createdByUserId: userId,
      userId: ownerId,

      kind: "upgrade_connections",
      subscriptionId: active._id,
      planId: String(active.plan),

      // upgrades => DELTAS
      seats: 0,
      firmCount: delta,
      vendorLinkCount: activeLinksCount,

      targetSeats: 0,
      targetFirmCount,

      baseAmount: 0,
      addonsAmount,
      amount,
      currency: planObj.currency,

      receipt,
      razorpayOrderId: rzpOrder.id,
      clientRequestId: reqId,
      notes: {
        remainingDays: remaining,
        prorationFactor: factor,
        vendorCode: String(me.vendorCode),
        linkId: String(link._id),
        firmId: String(link.firmId),
        activeLinksCount,
        firmLimitBefore: currentLimit,
        requiredExtraConnections: requiredExtra,
        targetFirmCount,
      },
    });

    return res.json({
      ok: true,
      keyId: getRazorpayKeyId(),
      order: { id: rzpOrder.id, amount: rzpOrder.amount, currency: rzpOrder.currency, receipt: rzpOrder.receipt },
      upgrade: {
        purchasedConnections: delta,
        requiredExtraConnections: requiredExtra,
        activeLinksCount,
        firmLimitBefore: currentLimit,
        targetFirmCount,
        remainingDays: remaining,
      },
      breakdown: { unitFirm, addonsAmount, amount },
      linkId: String(link._id),
    });
  } catch (err) {
    const rp = err?.error;
    if (rp?.description) return res.status(400).json({ message: rp.description, razorpay: rp });
    next(err);
  }
});

billingRouter.post("/vendor/add-connections/verify", async (req, res, next) => {
  try {
    const { ownerId, me } = await getSubscriptionOwner(req);
    if (!ownerId || !me) return res.status(401).json({ message: "Unauthorized" });
    if (!me.vendorCode) return res.status(403).json({ message: "Firms cannot use vendor add-connections API" });

    const { orderId, paymentId, signature } = req.body || {};
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ message: "orderId, paymentId, signature are required" });
    }

    const ok = verifyRazorpaySignature({ orderId, paymentId, signature });
    if (!ok) {
      await markPaymentOrderFailed({ orderId, paymentId });
      return res.status(400).json({ message: "Invalid payment signature" });
    }

    await withOptionalTransaction(async (session) => {
      const po = await lockPaymentOrderPaid({ orderId, paymentId, signature }, session);
      if (!po) throw new Error("Upgrade order not found");
      if (String(po.billingOwnerId) !== String(ownerId)) throw new Error("Not allowed");
      await applyUpgradeIfNeeded(po, session);
    });

    const po = await paymentOrderModel.findOne({ razorpayOrderId: String(orderId) }).lean();
    const sub = po?.subscriptionId ? await subscriptionModel.findById(po.subscriptionId).lean() : null;

    return res.json({ ok: true, message: "Connections upgrade processed", subscription: sub });
  } catch (err) {
    if (String(err?.message || "").includes("not found")) return res.status(404).json({ message: "Upgrade order not found" });
    if (String(err?.message || "").includes("Not allowed")) return res.status(403).json({ message: "Not allowed" });
    next(err);
  }
});

export default billingRouter;