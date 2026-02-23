import express from "express";
import mongoose from "mongoose";

import userModel from "../models/user.model.js";
import subscriptionModel from "../models/subscription.model.js";
import vendorFirmLinkModel from "../models/vendorFirmLink.model.js";

import { authorizeTokens } from "../middlewares/auth.middleware.js";

const router = express.Router();

/* ================= helpers ================= */

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

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Firm "owner id" resolution:
 * - If user is seat user: me.firmId exists => owner is firmId
 * - Else: owner is userId
 */
function getFirmOwnerIdFromMe(me, userId) {
  const firmId = toObjectIdMaybe(me?.firmId);
  return firmId || userId;
}

async function getMe(req) {
  const userId = getUserObjectId(req);
  if (!userId) return { userId: null, me: null };

  const me = await userModel
    .findById(userId, { name: 1, username: 1, status: 1, firmId: 1, vendorCode: 1 })
    .lean();

  if (!me) return { userId, me: null };
  if (Number(me.status) === 0) return { userId, me: null };

  return { userId, me };
}

async function getActiveSubscriptionByUserId(ownerId) {
  const now = new Date();
  return subscriptionModel
    .findOne({ userId: ownerId, status: "active", endAt: { $gt: now } })
    .sort({ endAt: -1 });
}

/**
 * IMPORTANT:
 * We keep "active" links but mark "covered by subscription" links by setting:
 *  - subscriptionId
 *  - endAt = subscription.endAt
 *
 * We choose covered links deterministically:
 *  - earliest active links first (createdAt asc)
 *  - cover up to subscription.firmLimit
 * Others remain active but uncovered (endAt=null) => upgrade required to cover them.
 */
async function syncVendorLinkCoverage(vendorCode, subscriptionDoc) {
  if (!vendorCode || !subscriptionDoc?.endAt) return;

  const firmLimit = Math.max(1, Number(subscriptionDoc.firmLimit || 1));
  const now = new Date();

  // expire old links (optional safety)
  await vendorFirmLinkModel.updateMany(
    { vendorCode: String(vendorCode), status: "active", endAt: { $ne: null, $lte: now } },
    { $set: { status: "expired" } }
  );

  const activeLinks = await vendorFirmLinkModel
    .find({
      vendorCode: String(vendorCode),
      status: "active",
      $or: [{ endAt: null }, { endAt: { $gt: now } }],
    })
    .sort({ createdAt: 1 })
    .select("_id startAt endAt subscriptionId")
    .lean();

  const covered = activeLinks.slice(0, firmLimit).map((x) => x._id);
  const uncovered = activeLinks.slice(firmLimit).map((x) => x._id);

  if (covered.length) {
    await vendorFirmLinkModel.updateMany(
      { _id: { $in: covered } },
      {
        $set: {
          subscriptionId: subscriptionDoc._id,
          endAt: subscriptionDoc.endAt,
        },
        $setOnInsert: { startAt: now },
      }
    );

    // also set startAt for covered links where missing
    await vendorFirmLinkModel.updateMany(
      { _id: { $in: covered }, startAt: null },
      { $set: { startAt: now } }
    );
  }

  if (uncovered.length) {
    // uncovered links are ACTIVE but NOT covered => endAt/subscriptionId cleared
    await vendorFirmLinkModel.updateMany(
      { _id: { $in: uncovered } },
      { $set: { subscriptionId: null, endAt: null } }
    );
  }
}

/** normalize firm target to firm OWNER */
async function normalizeFirmOwnerId(firmUserId) {
  const firmIdObj = toObjectIdMaybe(firmUserId);
  if (!firmIdObj) return null;

  const u = await userModel.findById(firmIdObj, { firmId: 1, vendorCode: 1, status: 1 }).lean();
  if (!u) return null;
  if (Number(u.status) === 0) return null;

  // do not allow linking to a vendor user as "firm"
  if (u.vendorCode) return null;

  const ownerId = toObjectIdMaybe(u.firmId) || firmIdObj;
  return ownerId;
}

/* ================= middleware ================= */

router.use(authorizeTokens);

/* ================= routes ================= */

/**
 * GET /api/connections/links?status=active|pending|...
 * - Vendor: links by vendorCode
 * - Firm: links by firm ownerId
 */
router.get("/links", async (req, res, next) => {
  try {
    const { userId, me } = await getMe(req);
    if (!userId || !me) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const now = new Date();

    // (optional) auto-expire active links with endAt in past
    await vendorFirmLinkModel.updateMany(
      { status: "active", endAt: { $ne: null, $lte: now } },
      { $set: { status: "expired" } }
    );

    const status = String(req.query.status || "").trim().toLowerCase();

    const isVendor = Boolean(me.vendorCode);
    const firmOwnerId = getFirmOwnerIdFromMe(me, userId);

    const baseFilter = isVendor
      ? { vendorCode: String(me.vendorCode) }
      : { firmId: firmOwnerId };

    const filter = { ...baseFilter };
    if (status) filter.status = status;

    const items = await vendorFirmLinkModel
      .find(filter)
      .sort({ updatedAt: -1 })
      .populate("firmId", "name username firmCode pincode address")
      .lean();

    // attach vendor info by vendorCode (not a ref)
    const codes = [...new Set(items.map((x) => x.vendorCode).filter(Boolean))];
    const vendors = await userModel
      .find({ vendorCode: { $in: codes } }, { vendorCode: 1, name: 1, username: 1, phone: 1, email: 1 })
      .lean();

    const vmap = new Map(vendors.map((v) => [String(v.vendorCode), v]));

    const out = items.map((x) => ({
      ...x,
      firm: x.firmId ? {
        _id: x.firmId?._id,
        name: x.firmId?.name,
        username: x.firmId?.username,
        firmCode: x.firmId?.firmCode,
        pincode: x.firmId?.pincode,
        address: x.firmId?.address,
      } : null,
      vendor: vmap.get(String(x.vendorCode)) ? {
        vendorCode: vmap.get(String(x.vendorCode))?.vendorCode,
        name: vmap.get(String(x.vendorCode))?.name,
        username: vmap.get(String(x.vendorCode))?.username,
        phone: vmap.get(String(x.vendorCode))?.phone,
        email: vmap.get(String(x.vendorCode))?.email,
      } : null,
    }));

    res.json({ ok: true, items: out });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/connections/requests/incoming
 * - Firm: pending requests initiated by vendor
 * - Vendor: pending requests initiated by firm (invites)
 */
router.get("/requests/incoming", async (req, res, next) => {
  try {
    const { userId, me } = await getMe(req);
    if (!userId || !me) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const isVendor = Boolean(me.vendorCode);
    const firmOwnerId = getFirmOwnerIdFromMe(me, userId);

    const filter = isVendor
      ? { vendorCode: String(me.vendorCode), status: "pending", requestedBy: "firm" }
      : { firmId: firmOwnerId, status: "pending", requestedBy: "vendor" };

    const items = await vendorFirmLinkModel
      .find(filter)
      .sort({ createdAt: -1 })
      .populate("firmId", "name username firmCode pincode address")
      .lean();

    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
});

/**
 * Vendor: search firms (firm owners only)
 * GET /api/connections/firms/search?q=
 */
router.get("/firms/search", async (req, res, next) => {
  try {
    const { userId, me } = await getMe(req);
    if (!userId || !me) return res.status(401).json({ ok: false, message: "Unauthorized" });
    if (!me.vendorCode) return res.status(403).json({ ok: false, message: "Only vendors can search firms" });

    const q = String(req.query.q || "").trim();
    const limit = clamp(req.query.limit, 1, 25);

    if (!q) return res.json({ ok: true, items: [] });

    const rx = new RegExp(escapeRegex(q), "i");

    // firm owner: firmId null/absent + vendorCode empty/absent
    const items = await userModel
      .find(
        {
          status: { $ne: 0 },
          $and: [
            { $or: [{ vendorCode: { $exists: false } }, { vendorCode: "" }, { vendorCode: null }] },
            { $or: [{ firmId: { $exists: false } }, { firmId: null }] },
          ],
          $or: [{ name: rx }, { username: rx }, { firmCode: rx }, { pincode: rx }],
        },
        { name: 1, username: 1, firmCode: 1, pincode: 1, address: 1 }
      )
      .limit(limit)
      .lean();

    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
});

/**
 * Firm: search vendors
 * GET /api/connections/vendors/search?q=
 */
router.get("/vendors/search", async (req, res, next) => {
  try {
    const { userId, me } = await getMe(req);
    if (!userId || !me) return res.status(401).json({ ok: false, message: "Unauthorized" });
    if (me.vendorCode) return res.status(403).json({ ok: false, message: "Vendors cannot search vendors" });

    const q = String(req.query.q || "").trim();
    const limit = clamp(req.query.limit, 1, 25);

    if (!q) return res.json({ ok: true, items: [] });

    const rx = new RegExp(escapeRegex(q), "i");

    const items = await userModel
      .find(
        {
          status: { $ne: 0 },
          vendorCode: { $exists: true, $ne: "" },
          $or: [{ vendorCode: rx }, { name: rx }, { username: rx }, { phone: rx }, { email: rx }],
        },
        { vendorCode: 1, name: 1, username: 1, phone: 1, email: 1 }
      )
      .limit(limit)
      .lean();

    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
});

/**
 * Vendor -> request link to firm
 * POST /api/connections/links/request
 * body: { firmId, message? }
 */
router.post("/links/request", async (req, res, next) => {
  try {
    const { userId, me } = await getMe(req);
    if (!userId || !me) return res.status(401).json({ ok: false, message: "Unauthorized" });
    if (!me.vendorCode) return res.status(403).json({ ok: false, message: "Only vendors can request links" });

    const { firmId, message } = req.body || {};
    const ownerId = await normalizeFirmOwnerId(firmId);
    if (!ownerId) return res.status(400).json({ ok: false, message: "Invalid firmId" });

    // prevent self-link (rare but safe)
    if (String(ownerId) === String(userId)) {
      return res.status(400).json({ ok: false, message: "Cannot connect to yourself" });
    }

    // prevent duplicates
    const existing = await vendorFirmLinkModel.findOne({
      firmId: ownerId,
      vendorCode: String(me.vendorCode),
      status: { $in: ["pending", "active"] },
    });

    if (existing) {
      return res.json({ ok: true, link: existing, message: "Already exists" });
    }

    const link = await vendorFirmLinkModel.create({
      firmId: ownerId,
      vendorCode: String(me.vendorCode),
      status: "pending",
      requestedBy: "vendor",
      requestedByUserId: userId,
      message: String(message || ""),
    });

    res.json({ ok: true, link });
  } catch (err) {
    next(err);
  }
});

/**
 * Firm -> invite vendor
 * POST /api/connections/links/invite
 * body: { vendorCode, message? }
 */
router.post("/links/invite", async (req, res, next) => {
  try {
    const { userId, me } = await getMe(req);
    if (!userId || !me) return res.status(401).json({ ok: false, message: "Unauthorized" });
    if (me.vendorCode) return res.status(403).json({ ok: false, message: "Vendors cannot invite vendors" });

    // ✅ IMPORTANT: firm employee => firmId, firm root => userId
    const firmOwnerId = getFirmOwnerIdFromMe(me, userId);

    const { vendorCode, message } = req.body || {};
    const code = String(vendorCode || "").trim();
    if (!code) return res.status(400).json({ ok: false, message: "vendorCode is required" });

    const vendorUser = await userModel.findOne(
      { vendorCode: code, status: { $ne: 0 } },
      { vendorCode: 1 }
    ).lean();
    if (!vendorUser) return res.status(404).json({ ok: false, message: "Vendor not found" });

    // ✅ duplicate check MUST use firmOwnerId (root), not userId
    const existing = await vendorFirmLinkModel.findOne({
      firmId: firmOwnerId,
      vendorCode: code,
      status: { $in: ["pending", "active"] },
    });

    if (existing) {
      return res.json({ ok: true, link: existing, message: "Already exists" });
    }

    // ✅ create link with firmId = firmOwnerId (root), even if inviter is employee
    const link = await vendorFirmLinkModel.create({
      firmId: firmOwnerId,
      vendorCode: code,
      status: "pending",
      requestedBy: "firm",

      // keep this as the *actor* (employee or root)
      requestedByUserId: userId,

      message: String(message || ""),
    });

    res.json({ ok: true, link });
  } catch (err) {
    next(err);
  }
});

/**
 * Accept link (receiver only)
 * POST /api/connections/links/:id/accept
 *
 * - If requestedBy=vendor => firm accepts
 * - If requestedBy=firm   => vendor accepts
 */
router.post("/links/:id/accept", async (req, res, next) => {
  try {
    const { userId, me } = await getMe(req);
    if (!userId || !me) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const linkId = req.params.id;
    if (!mongoose.isValidObjectId(String(linkId))) {
      return res.status(400).json({ ok: false, message: "Invalid link id" });
    }

    const link = await vendorFirmLinkModel.findById(linkId);
    if (!link) return res.status(404).json({ ok: false, message: "Link not found" });
    if (link.status !== "pending") return res.status(400).json({ ok: false, message: "Only pending links can be accepted" });

    const isVendor = Boolean(me.vendorCode);
    const firmOwnerId = getFirmOwnerIdFromMe(me, userId);

    // receiver check
    if (link.requestedBy === "vendor") {
      // firm must accept
      if (isVendor) return res.status(403).json({ ok: false, message: "Vendor cannot accept this request" });
      if (String(link.firmId) !== String(firmOwnerId)) return res.status(403).json({ ok: false, message: "Not allowed" });
    } else {
      // vendor must accept
      if (!isVendor) return res.status(403).json({ ok: false, message: "Firm cannot accept this invite" });
      if (String(link.vendorCode) !== String(me.vendorCode)) return res.status(403).json({ ok: false, message: "Not allowed" });
    }

    const now = new Date();

    link.status = "active";
    link.approvedByUserId = userId;
    link.startAt = link.startAt || now;
    // endAt/subscriptionId will be set by sync (if subscription exists)
    await link.save();

    // Sync vendor coverage to subscription (if vendor has active subscription)
    // We must find vendor ownerId:
    let vendorOwnerId = null;
    if (isVendor) {
      vendorOwnerId = userId;
    } else {
      // firm accepted vendor request -> resolve vendor user by vendorCode
      const v = await userModel.findOne({ vendorCode: String(link.vendorCode) }, { _id: 1, status: 1 }).lean();
      if (v && Number(v.status) !== 0) vendorOwnerId = v._id;
    }

    if (vendorOwnerId) {
      const sub = await getActiveSubscriptionByUserId(vendorOwnerId);
      if (sub) await syncVendorLinkCoverage(String(link.vendorCode), sub);
    }

    const updated = await vendorFirmLinkModel
      .findById(link._id)
      .populate("firmId", "name username firmCode pincode address")
      .lean();

    res.json({ ok: true, link: updated, message: "Connection activated" });
  } catch (err) {
    next(err);
  }
});

/**
 * Reject link (receiver only)
 * POST /api/connections/links/:id/reject
 */
router.post("/links/:id/reject", async (req, res, next) => {
  try {
    const { userId, me } = await getMe(req);
    if (!userId || !me) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const linkId = req.params.id;
    if (!mongoose.isValidObjectId(String(linkId))) {
      return res.status(400).json({ ok: false, message: "Invalid link id" });
    }

    const link = await vendorFirmLinkModel.findById(linkId);
    if (!link) return res.status(404).json({ ok: false, message: "Link not found" });
    if (link.status !== "pending") return res.status(400).json({ ok: false, message: "Only pending links can be rejected" });

    const isVendor = Boolean(me.vendorCode);
    const firmOwnerId = getFirmOwnerIdFromMe(me, userId);

    // receiver check
    if (link.requestedBy === "vendor") {
      if (isVendor) return res.status(403).json({ ok: false, message: "Vendor cannot reject this request" });
      if (String(link.firmId) !== String(firmOwnerId)) return res.status(403).json({ ok: false, message: "Not allowed" });
    } else {
      if (!isVendor) return res.status(403).json({ ok: false, message: "Firm cannot reject this invite" });
      if (String(link.vendorCode) !== String(me.vendorCode)) return res.status(403).json({ ok: false, message: "Not allowed" });
    }

    link.status = "rejected";
    link.approvedByUserId = userId;
    await link.save();

    res.json({ ok: true, message: "Rejected" });
  } catch (err) {
    next(err);
  }
});

/**
 * Cancel link (requester only)
 * POST /api/connections/links/:id/cancel
 */
router.post("/links/:id/cancel", async (req, res, next) => {
  try {
    const { userId, me } = await getMe(req);
    if (!userId || !me) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const linkId = req.params.id;
    if (!mongoose.isValidObjectId(String(linkId))) {
      return res.status(400).json({ ok: false, message: "Invalid link id" });
    }

    const link = await vendorFirmLinkModel.findById(linkId);
    if (!link) return res.status(404).json({ ok: false, message: "Link not found" });
    if (link.status !== "pending") return res.status(400).json({ ok: false, message: "Only pending links can be cancelled" });

    const isVendor = Boolean(me.vendorCode);
    const firmOwnerId = getFirmOwnerIdFromMe(me, userId);

    // requester check
    if (link.requestedBy === "vendor") {
      if (!isVendor) return res.status(403).json({ ok: false, message: "Only vendor requester can cancel" });
      if (String(link.vendorCode) !== String(me.vendorCode)) return res.status(403).json({ ok: false, message: "Not allowed" });
    } else {
      if (isVendor) return res.status(403).json({ ok: false, message: "Only firm requester can cancel" });
      if (String(link.firmId) !== String(firmOwnerId)) return res.status(403).json({ ok: false, message: "Not allowed" });
    }

    link.status = "cancelled";
    await link.save();

    res.json({ ok: true, message: "Cancelled" });
  } catch (err) {
    next(err);
  }
});

/**
 * Optional: disconnect active link (either side)
 * POST /api/connections/links/:id/disconnect
 */
router.post("/links/:id/disconnect", async (req, res, next) => {
  try {
    const { userId, me } = await getMe(req);
    if (!userId || !me) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const linkId = req.params.id;
    if (!mongoose.isValidObjectId(String(linkId))) {
      return res.status(400).json({ ok: false, message: "Invalid link id" });
    }

    const link = await vendorFirmLinkModel.findById(linkId);
    if (!link) return res.status(404).json({ ok: false, message: "Link not found" });

    const isVendor = Boolean(me.vendorCode);
    const firmOwnerId = getFirmOwnerIdFromMe(me, userId);

    const allowed =
      (isVendor && String(link.vendorCode) === String(me.vendorCode)) ||
      (!isVendor && String(link.firmId) === String(firmOwnerId));

    if (!allowed) return res.status(403).json({ ok: false, message: "Not allowed" });

    // we keep history => mark cancelled
    link.status = "cancelled";
    await link.save();

    res.json({ ok: true, message: "Disconnected" });
  } catch (err) {
    next(err);
  }
});

export default router;