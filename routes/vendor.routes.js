// routes/vendor.routes.js
import express from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import userModel from "../models/user.model.js";
import counterModel from "../models/counter.model.js";
import vendorFirmLinkModel from "../models/vendorFirmLink.model.js";
import { importVendors } from "../lib/importVendors.js";
import { authorizeTokens } from "../middlewares/auth.middleware.js";
import roleModel from "../models/role.model.js";
import { PERMISSIONS } from "../lib/permissions.js";

import { sendMail } from "../lib/nodemailer.js";
import generateEmailBody from "../helpers/generateEmailBody.js";

const vendorRouter = express.Router();

/** =========================
 *  ✅ STRONG MODE (AUTH REQUIRED)
 *  ========================= */
vendorRouter.use(authorizeTokens);

/** =========================
 *  Helpers: auth + firm linkage
 *  ========================= */

function getUserObjectId(req) {
  const raw = req?.user?._id || req?.user?.id || req?.user?.userId;
  if (!raw) return null;
  if (raw instanceof mongoose.Types.ObjectId) return raw;
  if (mongoose.isValidObjectId(String(raw)))
    return new mongoose.Types.ObjectId(String(raw));
  return null;
}

function toObjectIdMaybe(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  if (mongoose.isValidObjectId(String(v)))
    return new mongoose.Types.ObjectId(String(v));
  return null;
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// platform admin bypass (optional)
function isPlatformAdminUser(me) {
  if (!me) return false;
  if (me.isSuperAdmin === true || me.isPlatformAdmin === true) return true;
  const role = String(me.role || me.userType || me.type || "").toLowerCase();
  return ["superadmin", "platform_admin", "root_admin", "owner_admin"].includes(
    role,
  );
}

/**
 * Firm "owner id" resolution:
 * - If seat user: me.firmId exists => owner is firmId
 * - Else: owner is userId
 */
function getFirmOwnerIdFromMe(me, userId) {
  const firmId = toObjectIdMaybe(me?.firmId);
  return firmId || userId;
}

async function getMe(req) {
  const userId = getUserObjectId(req);
  if (!userId) {
    return {
      userId: null,
      me: null,
      isPlatformAdmin: false,
      firmOwnerId: null,
      isVendor: false,
    };
  }

  const me = await userModel
    .findById(userId, {
      name: 1,
      username: 1,
      status: 1,
      firmId: 1,
      vendorCode: 1,
      role: 1,
      userType: 1,
      type: 1,
      isSuperAdmin: 1,
      isPlatformAdmin: 1,
    })
    .lean();

  if (!me || Number(me.status) === 0) {
    return {
      userId,
      me: null,
      isPlatformAdmin: false,
      firmOwnerId: null,
      isVendor: false,
    };
  }

  const isVendor = Boolean(me.vendorCode && String(me.vendorCode).trim());
  const isPlatformAdmin = isPlatformAdminUser(me);
  const firmOwnerId = isVendor ? null : getFirmOwnerIdFromMe(me, userId);

  return { userId, me, isPlatformAdmin, firmOwnerId, isVendor };
}

/**
 * Returns vendorCodes linked to a firm owner via ACTIVE links.
 * Includes uncovered active links too (endAt = null).
 */
async function getLinkedVendorCodesForFirm(firmOwnerId) {
  if (!firmOwnerId) return [];
  const now = new Date();

  const codes = await vendorFirmLinkModel.distinct("vendorCode", {
    firmId: firmOwnerId,
    status: "active",
    $or: [{ endAt: null }, { endAt: { $gt: now } }],
  });

  return (codes || []).map((x) => String(x || "").trim()).filter(Boolean);
}

/**
 * Apply "strong" scope:
 * - Platform admin => no restriction
 * - Vendor => only self vendorCode
 * - Firm user (root/employee) => only vendors linked to their firm
 */
async function buildVendorScopeFilter(req, extraMatch = {}) {
  const { me, isVendor, isPlatformAdmin, firmOwnerId } = await getMe(req);
  if (!me) return { unauthorized: true, match: null, me: null };

  const match = {
    vendorCode: { $exists: true, $nin: [null, ""] },
    ...extraMatch,
  };

  if (isPlatformAdmin) {
    return { unauthorized: false, match, me };
  }

  if (isVendor) {
    match.vendorCode = String(me.vendorCode || "").trim();
    return { unauthorized: false, match, me };
  }

  const linkedCodes = await getLinkedVendorCodesForFirm(firmOwnerId);
  if (!linkedCodes.length) {
    match.vendorCode = { $in: ["__NONE__"] };
    return { unauthorized: false, match, me };
  }

  match.vendorCode = { $in: linkedCodes };
  return { unauthorized: false, match, me };
}

/** =========================
 *  Auto-increment helpers
 *  ========================= */
const COUNTER_ID = "vendorCode";
const VENDOR_PREFIX = "VND";
const PAD_LEN = 4;
const PREFIX_LEN = VENDOR_PREFIX.length;

let initPromise = null;

function pad(num, minLen) {
  const s = String(num);
  const width = Math.max(minLen, s.length);
  return s.padStart(width, "0");
}

/**
 * ✅ Get max sequence in DB numerically (safe even after 9999)
 * ✅ Reads from users collection (vendor users have vendorCode)
 */
async function getMaxVendorSeq() {
  const regex = new RegExp(`^${VENDOR_PREFIX}\\d+$`);

  const result = await userModel.aggregate([
    { $match: { vendorCode: { $regex: regex } } },
    {
      $project: {
        seq: {
          $toInt: {
            $substrCP: [
              "$vendorCode",
              PREFIX_LEN,
              { $subtract: [{ $strLenCP: "$vendorCode" }, PREFIX_LEN] },
            ],
          },
        },
      },
    },
    { $group: { _id: null, maxSeq: { $max: "$seq" } } },
  ]);

  return result?.[0]?.maxSeq || 0;
}

async function ensureVendorCounterInitialized() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const maxSeq = await getMaxVendorSeq();

    await counterModel.findByIdAndUpdate(
      COUNTER_ID,
      {
        $setOnInsert: { _id: COUNTER_ID },
        $max: { seq: maxSeq },
      },
      { upsert: true, new: true },
    );
  })();

  return initPromise;
}

async function nextVendorCode() {
  await ensureVendorCounterInitialized();

  const counter = await counterModel.findByIdAndUpdate(
    COUNTER_ID,
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );

  const seq = counter?.seq || 1;
  return `${VENDOR_PREFIX}${pad(seq, PAD_LEN)}`;
}

/** =========================
 *  Routes
 *  ========================= */

vendorRouter.get("/import", async (req, res, next) => {
  try {
    await importVendors(userModel);

    // re-init counter (important if import adds bigger vendorCodes)
    initPromise = null;
    await ensureVendorCounterInitialized();

    res.status(200).send({ success: true });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /vendor/list
 * - STRONG: firm sees only linked vendors, vendor sees only self
 * - Optional:
 *   - vendorCode
 *   - search
 */
vendorRouter.get("/list", async (req, res, next) => {
  try {
    const { vendorCode, search } = req.query;

    const ctx = await buildVendorScopeFilter(req);
    if (ctx.unauthorized)
      return res.status(401).send({ message: "Unauthorized" });

    const match = ctx.match;

    // If vendorCode is passed, enforce it doesn't escape scope
    if (vendorCode) {
      const code = String(vendorCode).trim();
      const vFilter = match.vendorCode;

      if (
        typeof vFilter === "object" &&
        vFilter?.$in &&
        !vFilter.$in.includes(code)
      ) {
        return res.status(403).send({ message: "Not allowed" });
      }

      match.vendorCode = code;
    }

    if (search) {
      const s = escapeRegex(String(search).trim());
      match.$or = [
        { vendorCode: { $regex: s, $options: "i" } },
        { name: { $regex: s, $options: "i" } },
        { orgName1: { $regex: s, $options: "i" } },
        { gstin: { $regex: s, $options: "i" } },
      ];
    }

    const data = await userModel.find(match).sort({ name: 1 });
    res.status(200).send(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /vendor/basic-details
 * - STRONG: firm sees only linked vendors, vendor sees only self
 */
vendorRouter.get("/basic-details", async (req, res, next) => {
  try {
    const ctx = await buildVendorScopeFilter(req);
    if (ctx.unauthorized)
      return res.status(401).send({ message: "Unauthorized" });

    const data = await userModel.find(ctx.match, {
      vendorCode: 1,
      name: 1,
      contactPerson: 1,
      street: 1,
    });

    res.status(200).send(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /vendor/values
 * - STRONG: firm sees only linked vendors, vendor sees only self
 * - Optional:
 *   - search
 */
vendorRouter.get("/values", async (req, res, next) => {
  try {
    const { search } = req.query;

    const ctx = await buildVendorScopeFilter(req);
    if (ctx.unauthorized)
      return res.status(401).send({ message: "Unauthorized" });

    const match = ctx.match;

    if (search) {
      const s = escapeRegex(String(search).trim());
      match.$or = [
        { vendorCode: { $regex: s, $options: "i" } },
        { name: { $regex: s, $options: "i" } },
        { orgName1: { $regex: s, $options: "i" } },
      ];
    }

    const data = await userModel.find(match, { vendorCode: 1, name: 1 });

    res.status(200).send(
      data.map((i) => ({
        label: i.name,
        value: i.vendorCode,
      })),
    );
  } catch (error) {
    next(error);
  }
});

/**
 * ✅ POST /vendor (auto vendorCode)
 * - creates vendor USER
 * - username = vendorCode
 * - password = vendorCode (stored hashed)
 */
// vendorRouter.post("/", async (req, res, next) => {
//   try {
//     const payload = req.body || {};

//     const name = String(payload.name || "").trim();
//     if (!name) {
//       return res.status(400).send({ success: false, message: "name is required." });
//     }

//     const contactPerson = Array.isArray(payload.contactPerson) ? payload.contactPerson : [];

//     const email =
//       String(payload.email || "").trim().toLowerCase() ||
//       String(contactPerson?.[0]?.email || "").trim().toLowerCase() ||
//       "";

//     let created = null;

//     for (let attempt = 0; attempt < 5; attempt++) {
//       const vendorCode = await nextVendorCode();

//       try {
//         const username = vendorCode;
//         const passwordHash = await bcrypt.hash(vendorCode, 10);

//         created = await userModel.create({
//           ...payload,

//           vendorCode,
//           firmId: null,

//           username,
//           password: passwordHash,
//           passwordStatus: "permanent",

//           name,
//           email,
//           contactPerson,

//           createdBy: req?.user?._id || req?.user?.id || null,
//           status: 1,
//         });

//         break;
//       } catch (e) {
//         if (e?.code === 11000) continue;
//         throw e;
//       }
//     }

//     if (!created) {
//       return res.status(500).send({
//         success: false,
//         message: "Unable to generate unique vendorCode. Please try again.",
//       });
//     }

//     res.status(201).send({ success: true, data: created });
//   } catch (error) {
//     next(error);
//   }
// });

/**
 * ✅ POST /vendor (auto vendorCode)
 * - creates vendor USER
 * - username = vendorCode
 * - password = vendorCode (stored hashed)
 * - sends credentials email to vendor
 */
vendorRouter.post("/", async (req, res, next) => {
  try {
    const payload = req.body || {};
    const vendorRole = await roleModel.findOne(
      { permissions: { $in: [PERMISSIONS.VENDOR_ACCESS] }, status: 1 },
      { _id: 1 },
    );

    const name = String(payload.name || "").trim();
    if (!name) {
      return res.status(400).send({
        success: false,
        message: "name is required.",
      });
    }

    const contactPerson = Array.isArray(payload.contactPerson)
      ? payload.contactPerson
      : [];

    const email =
      String(payload.email || "")
        .trim()
        .toLowerCase() ||
      String(contactPerson?.[0]?.email || "")
        .trim()
        .toLowerCase() ||
      "";

    let created = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const vendorCode = await nextVendorCode();

      try {
        const username = vendorCode;
        const passwordHash = await bcrypt.hash(vendorCode, 10);

        created = await userModel.create({
          ...payload,

          vendorCode,
          firmId: null,
          role: vendorRole._id,

          username,
          password: passwordHash,
          passwordStatus: "permanent",

          name,
          email,
          contactPerson,

          createdBy: req?.user?._id || req?.user?.id || null,
          status: 1,
        });

        break;
      } catch (e) {
        if (e?.code === 11000) continue;
        throw e;
      }
    }

    if (!created) {
      return res.status(500).send({
        success: false,
        message: "Unable to generate unique vendorCode. Please try again.",
      });
    }

    let emailSent = false;
    let emailError = null;

    if (email) {
      try {
        const mailResult = await sendMail([
          {
            to: email,
            subject: "Vendor Portal Login Credentials",
            text: generateEmailBody.vendorCredentials(
              created.username,
              created._id,
            ),
          },
        ]);

        emailSent = mailResult.ok;

        if (!mailResult.ok) {
          emailError =
            mailResult.results?.[0]?.error ||
            "Failed to send vendor credentials email";
        }
      } catch (mailErr) {
        emailError =
          mailErr?.message || "Failed to send vendor credentials email";
        console.error("Vendor credentials email failed:", mailErr);
      }
    } else {
      emailError = "Vendor email not found";
    }

    res.status(201).send({
      success: true,
      message: emailSent
        ? "Vendor created and credentials email sent"
        : "Vendor created but credentials email was not sent",
      data: created,
      emailSent,
      emailError,
      credentials: {
        username: created.username,
        password: created.vendorCode,
        vendorCode: created.vendorCode,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default vendorRouter;
