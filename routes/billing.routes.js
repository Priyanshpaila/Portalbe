import express from "express";
import mongoose from "mongoose";
import subscriptionModel from "../models/subscription.model.js";
import { authorizeTokens } from "../middlewares/auth.middleware.js";
import {
  razorpay,
  verifyRazorpaySignature,
  verifyRazorpayWebhookSignature,
  getRazorpayKeyId,
} from "../lib/razorpay.js";

const billingRouter = express.Router();

function getUserObjectId(req) {
  const raw = req?.user?._id || req?.user?.id || req?.user?.userId;
  if (!raw) return null;
  if (raw instanceof mongoose.Types.ObjectId) return raw;
  if (mongoose.isValidObjectId(String(raw)))
    return new mongoose.Types.ObjectId(String(raw));
  return null;
}

function getPlans() {
  const currency = process.env.SUB_CURRENCY || "INR";

  const monthlyAmount = Number(process.env.SUB_PLAN_MONTHLY_AMOUNT || 99900);
  const monthlyDays = Number(process.env.SUB_PLAN_MONTHLY_DAYS || 30);

  const yearlyAmount = Number(process.env.SUB_PLAN_YEARLY_AMOUNT || 999900);
  const yearlyDays = Number(process.env.SUB_PLAN_YEARLY_DAYS || 365);

  return {
    monthly: {
      plan: "monthly",
      amount: monthlyAmount,
      days: monthlyDays,
      currency,
    },
    yearly: {
      plan: "yearly",
      amount: yearlyAmount,
      days: yearlyDays,
      currency,
    },
  };
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

/**
 * ✅ PUBLIC: POST /api/billing/webhook/razorpay
 * Razorpay calls this. NO AUTH.
 */
billingRouter.post("/webhook/razorpay", async (req, res, next) => {
  try {
    const sig = req.headers["x-razorpay-signature"];

    const ok = verifyRazorpayWebhookSignature({
      rawBody: req.rawBody, // set by express.json verify() in server file
      signature: sig,
    });

    if (!ok) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid webhook signature" });
    }

    const event = req.body?.event;

    // We care about successful payment events
    if (
      event !== "payment.captured" &&
      event !== "order.paid" &&
      event !== "payment.failed"
    ) {
      return res.status(200).json({ ok: true }); // ack irrelevant events
    }

    const payment = req.body?.payload?.payment?.entity;
    const order = req.body?.payload?.order?.entity;

    const orderId = order?.id || payment?.order_id;
    const paymentId = payment?.id || null;

    if (!orderId) {
      return res
        .status(200)
        .json({ ok: true, message: "No orderId in webhook" });
    }

    // Find the pending subscription created during /order
    const pending = await subscriptionModel
      .findOne({ orderId })
      .sort({ createdAt: -1 });
    if (!pending) {
      // Still ACK webhook; your system may have created order outside
      return res
        .status(200)
        .json({ ok: true, message: "No matching subscription for orderId" });
    }

    // Idempotency: if already active, just ack
    if (pending.status === "active") {
      return res.status(200).json({ ok: true, message: "Already active" });
    }

    // If failed event => mark failed
    if (event === "payment.failed") {
      pending.status = "failed";
      pending.paymentId = paymentId;
      await pending.save();
      return res.status(200).json({ ok: true });
    }

    const plans = getPlans();
    const chosen = plans[pending.plan] || plans.monthly;
    const now = new Date();

    // Extend if currently active subscription exists
    const existingActive = await subscriptionModel
      .findOne({
        userId: pending.userId,
        status: "active",
        endAt: { $gt: now },
      })
      .sort({ endAt: -1 });

    const startAt = existingActive?.endAt
      ? new Date(existingActive.endAt)
      : now;
    const endAt = addDays(startAt, Number(chosen.days || 30));

    // expire old active (optional but clean)
    if (existingActive) {
      existingActive.status = "expired";
      await existingActive.save();
    }

    pending.status = "active";
    pending.paymentId = paymentId;
    pending.startAt = startAt;
    pending.endAt = endAt;

    // store webhook signature or gateway fields (optional)
    // pending.signature = sig;

    await pending.save();

    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * ✅ Everything below requires login (JWT)
 */
billingRouter.use(authorizeTokens);

/**
 * GET /api/billing/plans
 */
billingRouter.get("/plans", async (req, res, next) => {
  try {
    const plans = getPlans();
    res.json({
      ok: true,
      keyId: getRazorpayKeyId(),
      plans: Object.values(plans),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/billing/status
 */
billingRouter.get("/status", async (req, res, next) => {
  try {
    const userId = getUserObjectId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const now = new Date();

    const active = await subscriptionModel
      .findOne({ userId, status: "active", endAt: { $gt: now } })
      .sort({ endAt: -1 })
      .lean();

    const last = await subscriptionModel
      .findOne({ userId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      ok: true,
      active: Boolean(active),
      serverTime: now,
      subscription: active || last || null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/billing/order
 * body: { plan: "monthly" | "yearly" }
 */
billingRouter.post("/order", async (req, res, next) => {
  try {
    const userId = getUserObjectId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { plan } = req.body || {};
    const plans = getPlans();
    const chosen = plans[String(plan || "monthly")];

    if (!chosen) {
      return res.status(400).json({ message: "Invalid plan" });
    }

    // ✅ Razorpay receipt must be <= 40 chars
    const uid = String(userId);
    const receipt = `sub_${uid.slice(-8)}_${String(Date.now()).slice(-10)}`; // <= 40

    // ✅ CREATE ORDER (make sure variable name is used consistently)
    const rzpOrder = await razorpay.orders.create({
      amount: chosen.amount, // paise
      currency: chosen.currency, // INR
      receipt,
      notes: {
        userId: uid,
        plan: chosen.plan,
      },
    });

    // ✅ create pending subscription linked to this order
    const pending = await subscriptionModel.create({
      userId,
      plan: chosen.plan,
      status: "pending",
      orderId: rzpOrder.id,
      amount: chosen.amount,
      currency: chosen.currency,
      notes: { receipt },
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
    });
  } catch (err) {
    // ✅ If Razorpay throws 400, don't hide it as 500
    const rp = err?.error; // Razorpay SDK error shape
    if (rp?.description) {
      return res.status(400).json({
        message: rp.description,
        razorpay: rp,
      });
    }
    next(err);
  }
});

/**
 * POST /api/billing/verify
 * body: { orderId, paymentId, signature }
 *
 * Idempotent: if webhook already activated it, return active.
 */
billingRouter.post("/verify", async (req, res, next) => {
  try {
    const userId = getUserObjectId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { orderId, paymentId, signature } = req.body || {};
    if (!orderId || !paymentId || !signature) {
      return res
        .status(400)
        .json({ message: "orderId, paymentId, signature are required" });
    }

    const pending = await subscriptionModel
      .findOne({ userId, orderId })
      .sort({ createdAt: -1 });
    if (!pending)
      return res.status(404).json({ message: "Subscription order not found" });

    // If webhook already made it active, return success
    if (pending.status === "active") {
      return res.json({
        ok: true,
        message: "Already active",
        subscription: pending,
        active: true,
      });
    }

    const ok = verifyRazorpaySignature({ orderId, paymentId, signature });
    if (!ok) {
      pending.status = "failed";
      await pending.save();
      return res.status(400).json({ message: "Invalid payment signature" });
    }

    // Activate (same logic as webhook)
    const plans = getPlans();
    const chosen = plans[pending.plan] || plans.monthly;
    const now = new Date();

    const existingActive = await subscriptionModel
      .findOne({ userId, status: "active", endAt: { $gt: now } })
      .sort({ endAt: -1 });

    const startAt = existingActive?.endAt
      ? new Date(existingActive.endAt)
      : now;
    const endAt = addDays(startAt, Number(chosen.days || 30));

    if (existingActive) {
      existingActive.status = "expired";
      await existingActive.save();
    }

    pending.status = "active";
    pending.paymentId = paymentId;
    pending.signature = signature;
    pending.startAt = startAt;
    pending.endAt = endAt;

    await pending.save();

    return res.json({
      ok: true,
      message: "Subscription activated",
      subscription: pending,
      active: true,
    });
  } catch (err) {
    next(err);
  }
});

export default billingRouter;
