import mongoose from "mongoose";
import subscriptionModel from "../models/subscription.model.js";
import userModel from "../models/user.model.js";

function getUserObjectId(req) {
  const raw = req?.user?._id || req?.user?.id || req?.user?.userId;
  if (!raw) return null;
  if (raw instanceof mongoose.Types.ObjectId) return raw;
  if (mongoose.isValidObjectId(String(raw))) return new mongoose.Types.ObjectId(String(raw));
  return null;
}

function toObjectIdMaybe(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  if (mongoose.isValidObjectId(String(v))) return new mongoose.Types.ObjectId(String(v));
  return null;
}

// ✅ optional: normalize role checks
function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
}

export function subscriptionGuard(opts = {}) {
  const {
    bypassRoles = [],
    bypassPermissions = [],
    // ✅ optional shortcut if you use this permission
    platformBypassPermission = "platform:bypass_subscription",
  } = opts;

  const bypassRoleSet = new Set(bypassRoles.map((r) => normalizeRole(r)));

  return async function (req, res, next) {
    try {
      // 1) bypass by permission
      const perms = Array.isArray(req?.user?.permissions) ? req.user.permissions : [];
      if (platformBypassPermission && perms.includes(platformBypassPermission)) return next();

      if (Array.isArray(bypassPermissions) && bypassPermissions.length > 0) {
        const okByPerm = bypassPermissions.some((p) => perms.includes(p));
        if (okByPerm) return next();
      }

      // 2) bypass by role (if you use roles)
      const role = normalizeRole(req?.user?.role || req?.user?.roleName || req?.user?.userType);
      if (role && bypassRoleSet.has(role)) return next();

      const userId = getUserObjectId(req);
      if (!userId) {
        return res.status(401).json({ message: "Unauthorized (missing user id)" });
      }

      // ✅ include vendorCode (useful downstream)
      const me = await userModel.findById(userId, { firmId: 1, status: 1, vendorCode: 1 }).lean();
      if (!me) return res.status(401).json({ message: "Unauthorized (user not found)" });
      if (Number(me.status) === 0) return res.status(403).json({ message: "User is inactive" });

      const firmId = toObjectIdMaybe(me.firmId);
      const subscriptionOwnerId = firmId || userId;

      req.isSeatUser = Boolean(firmId && String(firmId) !== String(userId));
      req.subscriptionOwnerId = subscriptionOwnerId;
      req.subscriptionMode = firmId ? "firm-seat" : "self";

      req.isVendor = Boolean(me.vendorCode);
      req.vendorCode = me.vendorCode || null;

      const now = new Date();

      const active = await subscriptionModel
        .findOne({ userId: subscriptionOwnerId, status: "active", endAt: { $gt: now } })
        .sort({ endAt: -1 })
        .lean();

      if (active) {
        req.subscription = active;
        return next();
      }

      const last = await subscriptionModel
        .findOne({ userId: subscriptionOwnerId })
        .sort({ createdAt: -1 })
        .lean();

      return res.status(402).json({
        ok: false,
        code: "SUBSCRIPTION_REQUIRED",
        message: firmId ? "Firm subscription required or expired" : "Subscription required or expired",
        subscriptionOwner: {
          mode: firmId ? "firm-seat" : "self",
          userId: subscriptionOwnerId,
        },
        subscription: last
          ? {
              status: last.status,
              plan: last.plan,
              startAt: last.startAt,
              endAt: last.endAt,
              seats: last.seats ?? 1,
              firmLimit: last.firmLimit ?? 1,
            }
          : null,
        serverTime: now,
      });
    } catch (err) {
      next(err);
    }
  };
}