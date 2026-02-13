import mongoose from "mongoose";
import subscriptionModel from "../models/subscription.model.js";

function getUserObjectId(req) {
  // your auth middleware may set: req.user._id OR req.user.id OR req.user.userId
  const raw = req?.user?._id || req?.user?.id || req?.user?.userId;
  if (!raw) return null;

  // if already ObjectId
  if (raw instanceof mongoose.Types.ObjectId) return raw;

  // if string
  if (mongoose.isValidObjectId(String(raw))) return new mongoose.Types.ObjectId(String(raw));

  return null;
}

/**
 * subscriptionGuard()
 * - Checks active subscription for logged-in user
 * - If not active => blocks with 402 and a payload frontend can use
 */
export function subscriptionGuard(opts = {}) {
  const {
    // allow some roles to bypass (optional)
    bypassRoles = [], // e.g. ["SUPER_ADMIN"]
  } = opts;

  return async function (req, res, next) {
    try {
      // optional bypass by role
      const role = req?.user?.role || req?.user?.roleName;
      if (role && bypassRoles.includes(role)) return next();

      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ message: "Unauthorized (missing user id)" });
      }

      const now = new Date();

      const active = await subscriptionModel
        .findOne({
          userId,
          status: "active",
          endAt: { $gt: now },
        })
        .sort({ endAt: -1 })
        .lean();

      if (active) {
        req.subscription = active;
        return next();
      }

      // if no active, check last record for info
      const last = await subscriptionModel
        .findOne({ userId })
        .sort({ createdAt: -1 })
        .lean();

      return res.status(402).json({
        ok: false,
        code: "SUBSCRIPTION_REQUIRED",
        message: "Subscription required or expired",
        subscription: last
          ? {
              status: last.status,
              plan: last.plan,
              startAt: last.startAt,
              endAt: last.endAt,
            }
          : null,
        serverTime: now,
      });
    } catch (err) {
      next(err);
    }
  };
}