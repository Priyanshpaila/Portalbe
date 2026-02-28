// routes/user.routes.js
import express from "express";
import mongoose, { Types } from "mongoose";
import fs from "fs/promises";

import User from "../models/user.model.js";
import userModel from "../models/user.model.js";
import subscriptionModel from "../models/subscription.model.js";

import { createError } from "../lib/customError.js";
import { dataTable } from "../helpers/dataTable.js";
import { PERMISSIONS } from "../lib/permissions.js";
import { compareAsync, hashAsync } from "../helpers/hash.js";
import {
  authorizeTokens,
  authorizePermissions,
} from "../middlewares/auth.middleware.js";
import upload from "../middlewares/upload.middleware.js";
import roleModel from "../models/role.model.js";

const userRouter = express.Router();

/** =========================
 * Helpers
 * ========================= */

function safeJsonParse(v, fallback = null) {
  try {
    if (!v) return fallback;
    if (typeof v === "object") return v;
    if (typeof v !== "string") return fallback;
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function isValidObjectId(v) {
  return mongoose.isValidObjectId(String(v));
}

function oid(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  if (isValidObjectId(v)) return new mongoose.Types.ObjectId(String(v));
  return null;
}

async function getMe(req) {
  const meId = oid(req?.user?._id || req?.user?.id || req?.user?.userId);
  if (!meId) return null;
  return User.findById(meId).lean();
}

function isVendorUser(u) {
  return !!(u?.vendorCode && String(u.vendorCode).trim());
}

function isFirmEmployee(u) {
  return !isVendorUser(u) && !!u?.firmId;
}

function isFirmRoot(u) {
  return !isVendorUser(u) && !u?.firmId;
}

function getFirmRootId(u) {
  if (!u) return null;
  if (isFirmEmployee(u)) return oid(u.firmId);
  if (isFirmRoot(u)) return oid(u._id);
  return null;
}

async function getActiveSubscription(userId) {
  if (!userId) return null;
  const now = new Date();
  return subscriptionModel
    .findOne({ userId, status: "active", endAt: { $gt: now } })
    .sort({ endAt: -1 })
    .lean();
}

function pickFirmLimited(u) {
  return {
    _id: u._id,
    name: u.name || "",
    username: u.username || "",
    email: u.email || "",
    company: {
      name: u?.company?.name || "",
      industry: u?.company?.industry || "",
      city: u?.company?.city || "",
      state: u?.company?.state || "",
    },
  };
}

function pickFirmFull(u) {
  return {
    _id: u._id,
    name: u.name || "",
    username: u.username || "",
    email: u.email || "",
    company: u.company || {},
  };
}

/**
 * ✅ Vendor fields are now part of users collection (merged schema).
 * We expose them as vendorProfile in responses (same UX, no separate vendor collection).
 */
// ✅ Vendor fields live inside user.vendorProfile (NOT on root)
const VENDOR_FIELDS = [
  "vendorCode",
  "countryKey",
  "name",
  "name1",
  "name2",
  "name3",
  "name4",
  "city",
  "district",
  "poBox",
  "poBoxPostalCode",
  "postalCode",
  "creationDate",
  "sortField",
  "streetHouseNumber",
  "panNumber",
  "msme",
  "gstin",
  "orgName1",
  "orgName2",
  "companyCode",
  "cityPostalCode",
  "street",
  "street2",
  "street3",
  "street4",
  "street5",
  "languageKey",
  "region",
  "contactPerson",
];

function extractVendorProfile(u, mode = "basic") {
  if (!u) return null;
  if (!isVendorUser(u)) return null;

  const src =
    u.vendorProfile && typeof u.vendorProfile === "object"
      ? u.vendorProfile
      : {};

  const safeContact = Array.isArray(src.contactPerson) ? src.contactPerson : [];

  if (mode === "basic") {
    return {
      vendorCode: u.vendorCode || src.vendorCode || "",
      companyCode: src.companyCode || "",
      name: src.name || u.name || "",
      city: src.city || "",
      district: src.district || "",
      gstin: src.gstin || "",
      panNumber: src.panNumber || "",
      msme: src.msme || "",
      postalCode: src.postalCode || "",
      street: src.street || "",
      contactPerson: safeContact,
    };
  }

  // full
  const vp = {};
  for (const k of VENDOR_FIELDS) {
    if (k === "vendorCode") {
      vp.vendorCode = u.vendorCode || src.vendorCode || "";
      continue;
    }
    if (src[k] !== undefined) vp[k] = src[k];
  }

  // ✅ ensure always-present fields
  if (!vp.vendorCode) vp.vendorCode = u.vendorCode || "";
  if (!vp.name) vp.name = src.name || u.name || "";
  if (!Array.isArray(vp.contactPerson)) vp.contactPerson = safeContact;

  return vp;
}

function pickVendorBasic(vu) {
  return {
    _id: vu._id,
    vendorCode: vu.vendorCode,
    name: vu.name || "",
    username: vu.username || "",
    email: vu.email || "",
    vendorProfile: extractVendorProfile(vu, "basic"),
  };
}

function pickVendorFull(vu) {
  return {
    _id: vu._id,
    vendorCode: vu.vendorCode,
    name: vu.name || "",
    username: vu.username || "",
    email: vu.email || "",
    vendorProfile: extractVendorProfile(vu, "full"),
  };
}

function upsertLink(arr = [], key, keyField) {
  const idx = arr.findIndex((x) => String(x?.[keyField]) === String(key));
  if (idx >= 0) return { idx, item: arr[idx] };
  return { idx: -1, item: null };
}

/**
 * connectionStatus between me and target:
 * - uses vendorFirmLinks / firmVendorLinks depending on who is me
 */
function getConnectionStatus(me, targetId) {
  const t = String(targetId);
  if (isVendorUser(me)) {
    const entry = (me.vendorFirmLinks || []).find(
      (x) => String(x.firmUserId) === t,
    );
    return entry || null;
  }
  // firm (root/employee)
  const entry = (me.firmVendorLinks || []).find(
    (x) => String(x.vendorUserId) === t,
  );
  return entry || null;
}

/** =========================
 * Auth (tokens)
 * ========================= */
userRouter.use(authorizeTokens);

/** =========================
 * Profile endpoints (NEW)
 * ========================= */

/**
 * ✅ GET /users/profile
 * - Professional profile payload for frontend profile page
 * - includes: type, firmRoot (if employee), active subscription (owner-based), stats
 */
userRouter.get("/profile", async (req, res, next) => {
  try {
    const me = await User.findById(req.user._id, { password: 0 }).lean();
    if (!me) throw createError("User not found", 404);

    const type = isVendorUser(me)
      ? "vendor"
      : isFirmEmployee(me)
        ? "firm_employee"
        : "firm_root";

    const firmRootId = getFirmRootId(me);
    const firmRoot =
      type === "firm_employee" && firmRootId
        ? await User.findById(firmRootId, { password: 0 }).lean()
        : null;

    // ✅ subscription owner:
    // vendor: self
    // firm_root: self
    // firm_employee: firm root
    const subOwnerId = type === "firm_employee" ? firmRootId : oid(me._id);
    const subscription = await getActiveSubscription(subOwnerId);

    const stats = {
      connections: isVendorUser(me)
        ? (me.vendorFirmLinks || []).filter((x) => x.status !== "removed")
            .length
        : (firmRoot?.firmVendorLinks || me.firmVendorLinks || []).filter(
            (x) => x.status !== "removed",
          ).length,
      employees:
        type === "firm_root"
          ? await User.countDocuments({ firmId: me._id, status: 1 })
          : type === "firm_employee" && firmRootId
            ? await User.countDocuments({ firmId: firmRootId, status: 1 })
            : 0,
    };

    res.json({
      ok: true,
      type,
      profile: {
        ...me,
        vendorProfile: isVendorUser(me)
          ? extractVendorProfile(me, "full")
          : null,
        company: me.company || {},
      },
      firmRoot: firmRoot
        ? { ...firmRoot, company: firmRoot.company || {} }
        : null,
      subscription: subscription || null,
      stats,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * ✅ PATCH /users/profile
 * - Self edit (safe allowlist):
 *   - common: name, email
 *   - firm_root only: company fields
 *   - vendor only: vendor profile fields (except vendorCode)
 * NOTE: does NOT allow role/permissions/firmId/vendorCode changes here.
 */
userRouter.patch("/profile", async (req, res, next) => {
  try {
    const me = await User.findById(req.user._id);
    if (!me) throw createError("User not found", 404);

    const type = isVendorUser(me)
      ? "vendor"
      : isFirmEmployee(me)
        ? "firm_employee"
        : "firm_root";
    const body = req.body || {};

    const $set = {};

    // ✅ common editable
    if (body.name !== undefined) $set.name = String(body.name || "").trim();
    if (body.email !== undefined)
      $set.email = String(body.email || "")
        .trim()
        .toLowerCase();

    // ✅ firm root can edit company
    if (type === "firm_root") {
      const companyObj =
        safeJsonParse(body.company, null) ||
        (body.company && typeof body.company === "object"
          ? body.company
          : null);

      if (companyObj) {
        $set.company = {
          ...(me.company || {}),
          ...(companyObj || {}),
        };
      } else {
        // accept flat company fields (optional)
        const flat = {
          name: body.companyName ?? body.firmName,
          industry: body.industry,
          gstin: body.gstin,
          pan: body.pan,
          phone: body.phone,
          website: body.website,
          addressLine1: body.addressLine1,
          addressLine2: body.addressLine2,
          city: body.city,
          state: body.state,
          pincode: body.pincode,
        };
        const any = Object.values(flat).some((x) => x !== undefined);
        if (any) $set.company = { ...(me.company || {}), ...flat };
      }
    }

    // ✅ vendor can edit merged vendor fields (except vendorCode)
    if (type === "vendor") {
      const vp =
        safeJsonParse(body.vendorProfile, null) ||
        (body.vendorProfile && typeof body.vendorProfile === "object"
          ? body.vendorProfile
          : null) ||
        null;

      const source = vp || body;

      for (const k of VENDOR_FIELDS) {
        if (k === "vendorCode") continue; // never editable
        if (source[k] === undefined) continue;

        if (k === "contactPerson") {
          if (!Array.isArray(source.contactPerson)) {
            throw createError("contactPerson must be an array", 400);
          }
          // ✅ write inside vendorProfile
          $set["vendorProfile.contactPerson"] = source.contactPerson;
          continue;
        }

        // strings
        const val =
          typeof source[k] === "string" ? String(source[k]).trim() : source[k];
        // ✅ write inside vendorProfile
        $set[`vendorProfile.${k}`] = val;
      }

      // keep vendorProfile.vendorCode synced (optional but good)
      $set["vendorProfile.vendorCode"] = String(me.vendorCode || "").trim();
    }

    // ✅ firm_employee: limited edits only (no company/vendor)
    if (type === "firm_employee") {
      // already limited by only common fields above
    }

    if (!Object.keys($set).length) {
      const json = me.toJSON();
      delete json.password;
      return res.json({ ok: true, profile: json });
    }

    const updated = await User.findByIdAndUpdate(
      me._id,
      { $set },
      { new: true },
    );
    const json = updated.toJSON();
    delete json.password;

    res.json({ ok: true, profile: json });
  } catch (e) {
    next(e);
  }
});

/**
 * ✅ POST /users/profile/change-password
 * - Self password change with currentPassword verification
 * body: { currentPassword, newPassword }
 */
userRouter.post("/profile/change-password", async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      throw createError("currentPassword and newPassword are required", 400);
    }

    const user = await User.findById(req.user._id);
    if (!user) throw createError("User not found", 404);

    const ok = await compareAsync(String(currentPassword), user.password);
    if (!ok) throw createError("Current password is incorrect", 400);

    if (await compareAsync(String(newPassword), user.password)) {
      throw createError(
        "New password must be different from current password",
        405,
      );
    }

    const hashed = await hashAsync(String(newPassword), 10);

    // ✅ IMPORTANT: do not use user.save() here (it triggers company.name validation)
    await User.updateOne(
      { _id: user._id },
      { $set: { password: hashed, passwordStatus: "permanent" } },
    );

    return res.json({ ok: true, message: "Password updated successfully" });
  } catch (e) {
    next(e);
  }
});

/**
 * ✅ POST /users/profile/digital-signature
 * - Self upload/update digitalSignature (same behavior as admin PUT /:id)
 * multipart/form-data: digitalSignature=<file>
 */
userRouter.post(
  "/profile/digital-signature",
  (req, res, next) => {
    // so upload middleware can reuse the same folder logic if it depends on params.id
    req.params.id = String(req.user._id);
    next();
  },
  upload.single("digitalSignature"),
  async (req, res, next) => {
    try {
      if (!req.file)
        throw createError("digitalSignature file is required", 400);

      const curr = await User.findById(req.user._id, { digitalSignature: 1 });
      if (!curr) throw createError("User not found", 404);

      const newFile = req.file.filename;

      // remove old file (best-effort)
      if (curr?.digitalSignature) {
        await fs.rm(`uploads/${req.user._id}/${curr.digitalSignature}`, {
          force: true,
        });
      }

      const updated = await User.findByIdAndUpdate(
        req.user._id,
        { $set: { digitalSignature: newFile } },
        { new: true },
      );

      const json = updated.toJSON();
      delete json.password;

      res.json({
        ok: true,
        message: "Digital signature updated",
        profile: json,
      });
    } catch (e) {
      next(e);
    }
  },
);

/** =========================
 * Existing routes (kept) + fixed ordering
 * ========================= */

/**
 * ✅ GET /users/me
 */
userRouter.get("/me", async (req, res, next) => {
  try {
    const me = await getMe(req);
    if (!me) throw createError("User not found", 404);
    delete me.password;
    res.status(200).json(me);
  } catch (e) {
    next(e);
  }
});

/**
 * ✅ GET /users/me-or-all
 * (moved ABOVE "/:id" to avoid route collision)
 */
function toObjectIdMaybe(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  if (mongoose.isValidObjectId(String(v)))
    return new mongoose.Types.ObjectId(String(v));
  return null;
}

async function resolveCompanyForUser(u) {
  const companyName = String(u?.company?.name || "").trim();
  if (companyName) return u.company;

  const firmId = toObjectIdMaybe(u?.firmId);
  if (!firmId) return u?.company || {};

  const firmRoot = await User.findById(firmId, {
    company: 1,
    status: 1,
    vendorCode: 1,
  }).lean();
  if (!firmRoot) return u?.company || {};
  if (Number(firmRoot.status) === 0) return u?.company || {};
  if (firmRoot.vendorCode) return u?.company || {}; // don't treat vendor as firm

  return firmRoot.company || u?.company || {};
}

// ✅ GET /users/me-or-all
userRouter.get("/me-or-all", async (req, res, next) => {
  try {
    const me = await User.findById(req.user._id).lean();
    if (!me) throw createError("User not found", 404);

    const roleId = toObjectIdMaybe(me.role);

    // ✅ FIX: use roleModel
    const roleDoc = roleId
      ? await roleModel.findById(roleId, { name: 1 }).lean()
      : null;

    const roleName = String(roleDoc?.name || "").toLowerCase();
    const isAdmin = roleName === "superadmin";

    const stripPassword = (u) => {
      if (!u) return u;
      const { password, ...rest } = u;
      return rest;
    };

    // ✅ non-admin => return only self (with resolved firm-root company)
    if (!isAdmin) {
      const company = await resolveCompanyForUser(me);

      return res.status(200).json([
        {
          ...stripPassword(me),
          company,
          role: roleDoc ? { _id: roleDoc._id, name: roleDoc.name } : me.role,
        },
      ]);
    }

    // ✅ admin => return all users
    const users = await User.aggregate([
      {
        $lookup: {
          from: "roles",
          localField: "role",
          foreignField: "_id",
          pipeline: [{ $project: { name: 1 } }],
          as: "role",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          pipeline: [{ $project: { name: 1 } }],
          as: "createdBy",
        },
      },
      {
        $set: {
          role: { $first: "$role" }, // { _id, name }
          createdBy: { $first: "$createdBy.name" },
        },
      },
      { $unset: "password" },
    ]);

    return res.status(200).json(users);
  } catch (error) {
    next(error);
  }
});

/**
 * ✅ POST /users (Admin create)
 */
userRouter.post(
  "/",
  authorizePermissions(PERMISSIONS.ACCESS_CONTROL),
  (req, res, next) => {
    req.params.id = new Types.ObjectId().toString();
    next();
  },
  upload.single("digitalSignature"),
  async (req, res, next) => {
    try {
      const body = req.body || {};
      const { username, password, name, role, permissions, ...rest } = body;

      if (!username || !password || !name) {
        throw createError("username, password, name are required", 400);
      }

      const companyObj = safeJsonParse(body.company, null) || {
        name: body.companyName || body.firmName || "",
        industry: body.industry || "",
        gstin: body.gstin || "",
        pan: body.pan || "",
        phone: body.phone || "",
        website: body.website || "",
        addressLine1: body.addressLine1 || "",
        addressLine2: body.addressLine2 || "",
        city: body.city || "",
        state: body.state || "",
        pincode: body.pincode || "",
      };

      const vendorCode = body.vendorCode
        ? String(body.vendorCode).trim()
        : null;
      const firmId = oid(body.firmId);

      if (!vendorCode && !firmId && !companyObj?.name) {
        companyObj.name = String(name || "").trim();
      }

      if (req.file) rest.digitalSignature = req.file.filename;

      const hashedPassword = await hashAsync(password, 10);

      const newUser = new User({
        _id: req.params.id,
        username: String(username).trim(),
        password: hashedPassword,
        passwordStatus: "temporary",
        createdBy: req?.user?._id,
        name: String(name).trim(),
        permissions,
        role: role || null,

        vendorCode: vendorCode || null,
        firmId: firmId || null,
        company: companyObj,

        ...rest,
      });

      await newUser.save();

      const json = newUser.toJSON();
      delete json.password;
      res.status(201).json(json);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * ✅ POST /users/list (datatable)
 */
userRouter.post("/list", async (req, res, next) => {
  try {
    const { query, type, industry, companyName, ...params } = req.body || {};

    params.matchQuery = [{ $match: { status: 1 } }];

    if (query) {
      params.matchQuery.push({
        $match: {
          $or: [
            { name: { $regex: String(query), $options: "i" } },
            { username: { $regex: String(query), $options: "i" } },
            { vendorCode: { $regex: String(query), $options: "i" } },
            { "company.name": { $regex: String(query), $options: "i" } },
          ],
        },
      });
    }

    if (type) {
      const t = String(type).toLowerCase();
      if (t === "vendor")
        params.matchQuery.push({ $match: { vendorCode: { $ne: null } } });
      if (t === "firm")
        params.matchQuery.push({ $match: { vendorCode: null, firmId: null } });
      if (t === "employee")
        params.matchQuery.push({
          $match: { vendorCode: null, firmId: { $ne: null } },
        });
    }

    if (industry) {
      params.matchQuery.push({
        $match: {
          "company.industry": { $regex: String(industry), $options: "i" },
        },
      });
    }

    if (companyName) {
      params.matchQuery.push({
        $match: {
          "company.name": { $regex: String(companyName), $options: "i" },
        },
      });
    }

    const response = await dataTable(params, userModel, [
      {
        $lookup: {
          from: "roles",
          localField: "role",
          foreignField: "_id",
          pipeline: [{ $project: { name: 1 } }],
          as: "role",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          pipeline: [{ $project: { name: 1 } }],
          as: "createdBy",
        },
      },
      {
        $set: {
          role: { $first: "$role.name" },
          createdBy: { $first: "$createdBy.name" },
        },
      },
      { $unset: "password" },
    ]);

    res.status(200).send(response);
  } catch (error) {
    next(error);
  }
});

/**
 * ✅ GET /users
 */
userRouter.get("/", async (req, res, next) => {
  try {
    const users = await User.aggregate([
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          pipeline: [{ $project: { name: 1 } }],
          as: "createdBy",
        },
      },
      { $set: { createdBy: { $first: "$createdBy.name" } } },
      { $unset: "password" },
    ]);
    res.status(200).json(users);
  } catch (error) {
    next(error);
  }
});

function norm(v) {
  return String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function getEffectiveCompanyName(userId) {
  const me = await User.findById(userId, { company: 1, firmId: 1 }).lean();

  const direct =
    String(me?.company?.name ?? me?.company ?? "").trim();

  if (direct) return direct;

  // ✅ fallback: if user is employee and firm root has company
  if (me?.firmId) {
    const firm = await User.findById(me.firmId, { company: 1 }).lean();
    const firmCompany =
      String(firm?.company?.name ?? firm?.company ?? "").trim();
    if (firmCompany) return firmCompany;
  }

  return "";
}

userRouter.get("/po-vendors", authorizeTokens, async (req, res, next) => {
  try {
    // ✅ get roles who can authorize PO
    const roles = await roleModel.find(
      { permissions: { $in: [PERMISSIONS.AUTHORIZE_PO] } },
      { _id: 1 }
    );

    const myCompanyName = await getEffectiveCompanyName(req.user?._id);
    const myKey = norm(myCompanyName);

    // ✅ if still no company -> return [] (no leakage)
    if (!myKey) return res.status(200).json([]);

    const users = await User.aggregate([
      {
        $match: {
          role: { $in: roles.map((i) => i._id) },
        },
      },

      // ✅ bring firm root (if user has firmId)
      {
        $lookup: {
          from: "users",
          localField: "firmId",
          foreignField: "_id",
          as: "firmUser",
        },
      },
      {
        $set: {
          firmUser: { $first: "$firmUser" },
        },
      },

      // ✅ effectiveCompany = user.company.name || user.company || firm.company.name || firm.company
      {
        $addFields: {
          effectiveCompany: {
            $let: {
              vars: {
                cObj: { $ifNull: ["$company.name", ""] },
                cStr: { $ifNull: ["$company", ""] },
                fObj: { $ifNull: ["$firmUser.company.name", ""] },
                fStr: { $ifNull: ["$firmUser.company", ""] },
              },
              in: {
                $cond: [
                  { $gt: [{ $strLenCP: { $trim: { input: "$$cObj" } } }, 0] },
                  "$$cObj",
                  {
                    $cond: [
                      { $gt: [{ $strLenCP: { $trim: { input: "$$cStr" } } }, 0] },
                      "$$cStr",
                      {
                        $cond: [
                          { $gt: [{ $strLenCP: { $trim: { input: "$$fObj" } } }, 0] },
                          "$$fObj",
                          "$$fStr",
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },

      // ✅ normalize and match company
      {
        $addFields: {
          effectiveCompanyNorm: {
            $toLower: { $trim: { input: "$effectiveCompany" } },
          },
        },
      },
      {
        $match: {
          $expr: { $eq: ["$effectiveCompanyNorm", myKey] },
        },
      },

      // ✅ return
      {
        $project: {
          _id: 1,
          username: 1,
          name: 1,
          company: 1,
          effectiveCompany: 1,
        },
      },
    ]);

    res.status(200).json(users);
  } catch (error) {
    next(error);
  }
});

/**
 * ✅ PUT /users/:id (Admin update)
 */
userRouter.put(
  "/:id",
  authorizePermissions(PERMISSIONS.ACCESS_CONTROL),
  upload.single("digitalSignature"),
  async (req, res, next) => {
    try {
      const body = req.body || {};

      let digitalSignature = body.digitalSignature;

      if (req.file) {
        digitalSignature = req.file.filename;

        const currData = await User.findById(req.params.id, {
          digitalSignature: 1,
        });
        if (currData?.digitalSignature) {
          await fs.rm(`uploads/${req.params.id}/${currData.digitalSignature}`, {
            force: true,
          });
        }
      }

      const companyObj = safeJsonParse(body.company, null);
      const firmId = oid(body.firmId);

      const updatedData = {};

      const setIf = (k, v) => {
        if (v !== undefined) updatedData[k] = v;
      };

      setIf(
        "username",
        body.username ? String(body.username).trim() : undefined,
      );
      setIf("name", body.name ? String(body.name).trim() : undefined);
      setIf(
        "vendorCode",
        body.vendorCode !== undefined
          ? String(body.vendorCode).trim() || null
          : undefined,
      );
      setIf(
        "email",
        body.email !== undefined ? String(body.email).trim() : undefined,
      );
      setIf("role", body.role !== undefined ? body.role : undefined);
      setIf(
        "digitalSignature",
        digitalSignature !== undefined ? digitalSignature : undefined,
      );
      setIf("firmId", body.firmId !== undefined ? firmId : undefined);

      if (companyObj) {
        updatedData.company = {
          ...(companyObj || {}),
        };
      } else {
        const flatCompany = {
          name: body.companyName || body.firmName,
          industry: body.industry,
          gstin: body.gstin,
          pan: body.pan,
          phone: body.phone,
          website: body.website,
          addressLine1: body.addressLine1,
          addressLine2: body.addressLine2,
          city: body.city,
          state: body.state,
          pincode: body.pincode,
        };
        const any = Object.values(flatCompany).some((x) => x !== undefined);
        if (any) updatedData.company = flatCompany;
      }

      const user = await User.findByIdAndUpdate(
        req.params.id,
        { $set: updatedData },
        { new: true },
      );
      if (!user) throw createError("User not found", 404);

      const json = user.toJSON();
      delete json.password;
      res.status(200).json(json);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * ✅ DELETE /users/:id (kept)
 */
userRouter.delete(
  "/:id",
  authorizePermissions(PERMISSIONS.ACCESS_CONTROL),
  async (req, res, next) => {
    try {
      const user = await User.findByIdAndDelete(req.params.id);
      if (!user) throw createError("User not found", 404);
      if (user.digitalSignature)
        await fs.rm("uploads/" + req.params.id, {
          recursive: true,
          force: true,
        });
      res.status(200).json({ message: "User deleted successfully" });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * ✅ POST /users/reset-password (kept)
 */
userRouter.post("/reset-password", async (req, res, next) => {
  try {
    const { password } = req.body || {};
    const user = await User.findById(req.user._id);
    if (!user) throw createError("User not found", 404);

    const resetBySelf = String(req.user._id) === String(user._id);

    if (!password) throw createError("password is required", 400);
    if ((await compareAsync(password, user.password)) && resetBySelf) {
      throw createError(
        "New password must be different from previous password.",
        405,
      );
    }

    user.password = await hashAsync(password, 10);
    user.passwordStatus = resetBySelf ? "permanent" : "temporary";
    await user.save();

    res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    next(error);
  }
});

/** =========================================================
 * Firm seat users (employees under firm subscription)
 * ========================================================= */

/**
 * GET /users/firm/employees
 */
userRouter.get("/firm/employees", async (req, res, next) => {
  try {
    const me = await getMe(req);
    if (!me) throw createError("User not found", 404);
    if (isVendorUser(me))
      throw createError("Vendors cannot access firm employees", 403);

    const firmRootId = getFirmRootId(me);
    if (!firmRootId) throw createError("Invalid firm context", 400);

    const employees = await User.find(
      { firmId: firmRootId, status: 1 },
      { password: 0 },
    ).sort({ createdAt: -1 });

    res.json({ ok: true, firmId: firmRootId, employees });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /users/firm/employees
 */
userRouter.post("/firm/employees", async (req, res, next) => {
  try {
    const me = await getMe(req);
    if (!me) throw createError("User not found", 404);
    if (!isFirmRoot(me))
      throw createError("Only firm root can create employees", 403);

    const { username, password, name, email, role } = req.body || {};
    if (!username || !password || !name) {
      throw createError("username, password, name are required", 400);
    }

    const activeSub = await getActiveSubscription(me._id);
    if (!activeSub)
      throw createError("Active subscription required to add employees", 402);

    const seatsAllowed = Number(activeSub?.notes?.seats || 0);
    if (seatsAllowed > 0) {
      const used = await User.countDocuments({ firmId: me._id, status: 1 });
      if (used >= seatsAllowed) {
        throw createError(
          `Seat limit reached (${seatsAllowed}). Upgrade plan to add more users.`,
          402,
        );
      }
    }

    // ✅ normalize + clone company snapshot from firm root
    const normalizeCompany = (c) => ({
      name: String(c?.name || "").trim(),
      industry: String(c?.industry || "").trim(),
      gstin: String(c?.gstin || "").trim(),
      pan: String(c?.pan || "").trim(),
      phone: String(c?.phone || "").trim(),
      website: String(c?.website || "").trim(),
      addressLine1: String(c?.addressLine1 || "").trim(),
      addressLine2: String(c?.addressLine2 || "").trim(),
      city: String(c?.city || "").trim(),
      state: String(c?.state || "").trim(),
      pincode: String(c?.pincode || "").trim(),
    });

    const companySnapshot = normalizeCompany(me?.company);

    const hashedPassword = await hashAsync(String(password), 10);

    const employee = await User.create({
      _id: new Types.ObjectId(), // ✅ keep as ObjectId
      firmId: me._id, // firm owner id
      username: String(username).trim(),
      password: hashedPassword,
      passwordStatus: "temporary",
      createdBy: me._id,
      name: String(name).trim(),
      email: email ? String(email).trim() : "",
      role: role || null,
      status: 1,

      // ✅ HERE: copy firm root company into employee
      company: companySnapshot,
    });

    const json = employee.toJSON();
    delete json.password;
    res.status(201).json({ ok: true, employee: json });
  } catch (e) {
    next(e);
  }
});

/** =========================================================
 * Connect / Tie / Untie
 * ========================================================= */

userRouter.post("/connections/request", async (req, res, next) => {
  try {
    const me = await getMe(req);
    if (!me) throw createError("User not found", 404);

    const body = req.body || {};
    let target = null;

    if (isVendorUser(me)) {
      if (body.targetUserId && isValidObjectId(body.targetUserId)) {
        target = await User.findById(body.targetUserId).lean();
      } else if (body.firmUsername) {
        target = await User.findOne({
          username: String(body.firmUsername).trim(),
          status: 1,
        }).lean();
      } else {
        throw createError("targetUserId or firmUsername required", 400);
      }

      if (!target) throw createError("Firm not found", 404);
      if (isVendorUser(target))
        throw createError("Vendors cannot connect to vendors", 400);
    } else {
      if (body.targetUserId && isValidObjectId(body.targetUserId)) {
        target = await User.findById(body.targetUserId).lean();
      } else if (body.vendorCode) {
        target = await User.findOne({
          vendorCode: String(body.vendorCode).trim(),
          status: 1,
        }).lean();
      } else {
        throw createError("targetUserId or vendorCode required", 400);
      }

      if (!target) throw createError("Vendor not found", 404);
      if (!isVendorUser(target))
        throw createError("Firms cannot connect to firms", 400);
    }

    const now = new Date();

    if (isVendorUser(me)) {
      const meDoc = await User.findById(me._id);
      const tDoc = await User.findById(target._id);
      if (!meDoc || !tDoc) throw createError("User not found", 404);

      const a = upsertLink(
        meDoc.vendorFirmLinks || [],
        target._id,
        "firmUserId",
      );
      if (a.idx < 0) {
        meDoc.vendorFirmLinks = [
          ...(meDoc.vendorFirmLinks || []),
          {
            firmUserId: target._id,
            status: "pending",
            activeUntil: null,
            createdAt: now,
          },
        ];
      }

      const firmRootId = getFirmRootId(tDoc) || tDoc._id;
      const firmRoot = await User.findById(firmRootId);
      if (!firmRoot) throw createError("Firm root not found", 404);

      const b = upsertLink(
        firmRoot.firmVendorLinks || [],
        me._id,
        "vendorUserId",
      );
      if (b.idx < 0) {
        firmRoot.firmVendorLinks = [
          ...(firmRoot.firmVendorLinks || []),
          {
            vendorUserId: me._id,
            status: "pending",
            activeUntil: null,
            createdAt: now,
          },
        ];
      }

      await meDoc.save();
      await firmRoot.save();

      return res.json({
        ok: true,
        message: "Request sent",
        targetUserId: target._id,
      });
    } else {
      const firmRootId = getFirmRootId(me);
      if (!firmRootId) throw createError("Invalid firm context", 400);

      const firmRoot = await User.findById(firmRootId);
      const vendorUser = await User.findById(target._id);
      if (!firmRoot || !vendorUser) throw createError("User not found", 404);

      const a = upsertLink(
        firmRoot.firmVendorLinks || [],
        vendorUser._id,
        "vendorUserId",
      );
      if (a.idx < 0) {
        firmRoot.firmVendorLinks = [
          ...(firmRoot.firmVendorLinks || []),
          {
            vendorUserId: vendorUser._id,
            status: "pending",
            activeUntil: null,
            createdAt: now,
          },
        ];
      }

      const b = upsertLink(
        vendorUser.vendorFirmLinks || [],
        firmRoot._id,
        "firmUserId",
      );
      if (b.idx < 0) {
        vendorUser.vendorFirmLinks = [
          ...(vendorUser.vendorFirmLinks || []),
          {
            firmUserId: firmRoot._id,
            status: "pending",
            activeUntil: null,
            createdAt: now,
          },
        ];
      }

      await firmRoot.save();
      await vendorUser.save();

      return res.json({
        ok: true,
        message: "Request sent",
        targetUserId: target._id,
      });
    }
  } catch (e) {
    next(e);
  }
});

userRouter.post("/connections/respond", async (req, res, next) => {
  try {
    const me = await getMe(req);
    if (!me) throw createError("User not found", 404);

    const { targetUserId, action } = req.body || {};
    if (!targetUserId || !isValidObjectId(targetUserId))
      throw createError("targetUserId required", 400);

    const act = String(action || "").toLowerCase();
    if (!["accept", "decline", "block"].includes(act))
      throw createError("Invalid action", 400);

    const target = await User.findById(targetUserId);
    const meDoc = await User.findById(me._id);

    if (!target || !meDoc) throw createError("User not found", 404);

    if (isVendorUser(meDoc)) {
      if (isVendorUser(target))
        throw createError("Vendors cannot respond to vendors", 400);

      const firmRootId = getFirmRootId(target) || target._id;
      const firmRoot = await User.findById(firmRootId);
      if (!firmRoot) throw createError("Firm root not found", 404);

      const vIdx = (meDoc.vendorFirmLinks || []).findIndex(
        (x) => String(x.firmUserId) === String(firmRoot._id),
      );
      const fIdx = (firmRoot.firmVendorLinks || []).findIndex(
        (x) => String(x.vendorUserId) === String(meDoc._id),
      );

      if (vIdx < 0 || fIdx < 0)
        throw createError("No pending request found", 404);

      if (act === "accept") {
        const sub = await getActiveSubscription(meDoc._id);
        if (!sub)
          throw createError(
            "Vendor subscription required to activate connection",
            402,
          );

        meDoc.vendorFirmLinks[vIdx].status = "active";
        meDoc.vendorFirmLinks[vIdx].activeUntil = sub.endAt;

        firmRoot.firmVendorLinks[fIdx].status = "active";
        firmRoot.firmVendorLinks[fIdx].activeUntil = sub.endAt;
      } else {
        const status = act === "block" ? "blocked" : "removed";
        meDoc.vendorFirmLinks[vIdx].status = status;
        meDoc.vendorFirmLinks[vIdx].activeUntil = null;

        firmRoot.firmVendorLinks[fIdx].status = status;
        firmRoot.firmVendorLinks[fIdx].activeUntil = null;
      }

      await meDoc.save();
      await firmRoot.save();

      return res.json({ ok: true, message: `Request ${act}ed` });
    } else {
      if (!isVendorUser(target))
        throw createError("Firms cannot respond to firms", 400);

      const firmRootId = getFirmRootId(meDoc);
      if (!firmRootId) throw createError("Invalid firm context", 400);

      const firmRoot = await User.findById(firmRootId);
      const vendorUser = await User.findById(target._id);
      if (!firmRoot || !vendorUser) throw createError("User not found", 404);

      const fIdx = (firmRoot.firmVendorLinks || []).findIndex(
        (x) => String(x.vendorUserId) === String(vendorUser._id),
      );
      const vIdx = (vendorUser.vendorFirmLinks || []).findIndex(
        (x) => String(x.firmUserId) === String(firmRoot._id),
      );

      if (fIdx < 0 || vIdx < 0)
        throw createError("No pending request found", 404);

      if (act === "accept") {
        const sub = await getActiveSubscription(vendorUser._id);
        if (!sub)
          throw createError(
            "Vendor subscription required to activate connection",
            402,
          );

        firmRoot.firmVendorLinks[fIdx].status = "active";
        firmRoot.firmVendorLinks[fIdx].activeUntil = sub.endAt;

        vendorUser.vendorFirmLinks[vIdx].status = "active";
        vendorUser.vendorFirmLinks[vIdx].activeUntil = sub.endAt;
      } else {
        const status = act === "block" ? "blocked" : "removed";
        firmRoot.firmVendorLinks[fIdx].status = status;
        firmRoot.firmVendorLinks[fIdx].activeUntil = null;

        vendorUser.vendorFirmLinks[vIdx].status = status;
        vendorUser.vendorFirmLinks[vIdx].activeUntil = null;
      }

      await firmRoot.save();
      await vendorUser.save();

      return res.json({ ok: true, message: `Request ${act}ed` });
    }
  } catch (e) {
    next(e);
  }
});

userRouter.post("/connections/remove", async (req, res, next) => {
  try {
    const me = await getMe(req);
    if (!me) throw createError("User not found", 404);

    const { targetUserId } = req.body || {};
    if (!targetUserId || !isValidObjectId(targetUserId))
      throw createError("targetUserId required", 400);

    const meDoc = await User.findById(me._id);
    const target = await User.findById(targetUserId);
    if (!meDoc || !target) throw createError("User not found", 404);

    if (isVendorUser(meDoc) && isVendorUser(target))
      throw createError("Not allowed", 400);
    if (!isVendorUser(meDoc) && !isVendorUser(target))
      throw createError("Not allowed", 400);

    let firmRoot = null;
    let vendorUser = null;

    if (isVendorUser(meDoc)) {
      vendorUser = meDoc;
      firmRoot = await User.findById(getFirmRootId(target) || target._id);
    } else {
      firmRoot = await User.findById(getFirmRootId(meDoc) || meDoc._id);
      vendorUser = target;
    }

    if (!firmRoot || !vendorUser) throw createError("Invalid link", 400);

    const fIdx = (firmRoot.firmVendorLinks || []).findIndex(
      (x) => String(x.vendorUserId) === String(vendorUser._id),
    );
    const vIdx = (vendorUser.vendorFirmLinks || []).findIndex(
      (x) => String(x.firmUserId) === String(firmRoot._id),
    );

    if (fIdx >= 0) {
      firmRoot.firmVendorLinks[fIdx].status = "removed";
      firmRoot.firmVendorLinks[fIdx].activeUntil = null;
    }
    if (vIdx >= 0) {
      vendorUser.vendorFirmLinks[vIdx].status = "removed";
      vendorUser.vendorFirmLinks[vIdx].activeUntil = null;
    }

    await firmRoot.save();
    await vendorUser.save();

    return res.json({ ok: true, message: "Connection removed" });
  } catch (e) {
    next(e);
  }
});

userRouter.get("/connections", async (req, res, next) => {
  try {
    const me = await getMe(req);
    if (!me) throw createError("User not found", 404);

    const now = new Date();

    if (isVendorUser(me)) {
      const firmIds = (me.vendorFirmLinks || [])
        .filter((x) => x.status !== "removed")
        .map((x) => x.firmUserId);

      const firms = await User.find({
        _id: { $in: firmIds },
        status: 1,
      }).lean();

      return res.json({
        ok: true,
        type: "vendor",
        connections: (me.vendorFirmLinks || []).map((l) => ({
          ...l,
          firm: pickFirmLimited(
            firms.find((f) => String(f._id) === String(l.firmUserId)) || {},
          ),
          isActive:
            l.status === "active" &&
            (!l.activeUntil || new Date(l.activeUntil) > now),
        })),
      });
    }

    const firmRootId = getFirmRootId(me);
    const firmRoot = await User.findById(firmRootId).lean();

    const vendorIds = (firmRoot?.firmVendorLinks || [])
      .filter((x) => x.status !== "removed")
      .map((x) => x.vendorUserId);

    const vendors = await User.find({
      _id: { $in: vendorIds },
      status: 1,
    }).lean();

    return res.json({
      ok: true,
      type: "firm",
      connections: (firmRoot?.firmVendorLinks || []).map((l) => {
        const vu = vendors.find(
          (v) => String(v._id) === String(l.vendorUserId),
        );
        const isActive =
          l.status === "active" &&
          (!l.activeUntil || new Date(l.activeUntil) > now);
        return {
          ...l,
          vendor: vu
            ? isActive
              ? pickVendorFull(vu)
              : pickVendorBasic(vu)
            : null,
          isActive,
        };
      }),
    });
  } catch (e) {
    next(e);
  }
});

/** =========================================================
 * Directory (vendor <-> firm)
 * ========================================================= */

userRouter.get("/directory", async (req, res, next) => {
  try {
    const me = await getMe(req);
    if (!me) throw createError("User not found", 404);

    const search = String(req.query.search || "").trim();
    const discover = String(req.query.discover || "0") === "1";

    const now = new Date();

    if (isVendorUser(me)) {
      const baseMatch = {
        status: 1,
        vendorCode: null,
        firmId: null,
      };

      const firmQuery = { ...baseMatch };
      if (search) {
        firmQuery.$or = [
          { name: { $regex: search, $options: "i" } },
          { username: { $regex: search, $options: "i" } },
          { "company.name": { $regex: search, $options: "i" } },
          { "company.industry": { $regex: search, $options: "i" } },
        ];
      }

      let allowFirmIds = null;
      if (!discover) {
        allowFirmIds = (me.vendorFirmLinks || [])
          .filter((x) => x.status === "active" || x.status === "pending")
          .map((x) => x.firmUserId);
      }

      const firms = await User.find(
        allowFirmIds ? { ...firmQuery, _id: { $in: allowFirmIds } } : firmQuery,
      ).lean();

      const data = firms.map((f) => {
        const link =
          (me.vendorFirmLinks || []).find(
            (x) => String(x.firmUserId) === String(f._id),
          ) || null;
        const isActive =
          link?.status === "active" &&
          (!link?.activeUntil || new Date(link.activeUntil) > now);
        return {
          type: "firm",
          connection: link
            ? { status: link.status, activeUntil: link.activeUntil }
            : null,
          firm: pickFirmLimited(f),
          isActive,
        };
      });

      return res.json({ ok: true, viewerType: "vendor", data });
    }

    const firmRootId = getFirmRootId(me);
    if (!firmRootId) throw createError("Invalid firm context", 400);

    const firmRoot = await User.findById(firmRootId).lean();
    const firmLinks = firmRoot?.firmVendorLinks || [];

    let allowVendorIds = null;
    if (!discover) {
      allowVendorIds = firmLinks
        .filter((x) => x.status === "active" || x.status === "pending")
        .map((x) => x.vendorUserId);
    }

    const vendorQuery = {
      status: 1,
      vendorCode: { $ne: null },
    };

    if (search) {
      vendorQuery.$or = [
        { name: { $regex: search, $options: "i" } },
        { username: { $regex: search, $options: "i" } },
        { vendorCode: { $regex: search, $options: "i" } },
      ];
    }

    const vendorUsers = await User.find(
      allowVendorIds
        ? { ...vendorQuery, _id: { $in: allowVendorIds } }
        : vendorQuery,
    ).lean();

    const data = vendorUsers.map((vu) => {
      const link =
        firmLinks.find((x) => String(x.vendorUserId) === String(vu._id)) ||
        null;
      const isActive =
        link?.status === "active" &&
        (!link?.activeUntil || new Date(link.activeUntil) > now);

      return {
        type: "vendor",
        connection: link
          ? { status: link.status, activeUntil: link.activeUntil }
          : null,
        vendor: isActive ? pickVendorFull(vu) : pickVendorBasic(vu),
        isActive,
      };
    });

    return res.json({ ok: true, viewerType: "firm", data });
  } catch (e) {
    next(e);
  }
});

/**
 * ✅ GET /users/:id (kept at bottom)
 */
userRouter.get("/:id", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id, { password: 0 });
    if (!user) throw createError("User not found", 404);
    res.status(200).json(user);
  } catch (error) {
    next(error);
  }
});

export default userRouter;
