import express from "express"
import mongoose, { Types } from "mongoose"
import fs from "fs/promises"

import User from "../models/user.model.js"
import userModel from "../models/user.model.js"
import vendorModel from "../models/vendor.model.js"
import subscriptionModel from "../models/subscription.model.js"

import { createError } from "../lib/customError.js"
import { dataTable } from "../helpers/dataTable.js"
import { PERMISSIONS } from "../lib/permissions.js"
import { compareAsync, hashAsync } from "../helpers/hash.js"
import { authorizeTokens, authorizePermissions } from "../middlewares/auth.middleware.js"
import upload from "../middlewares/upload.middleware.js"
import roleModel from "../models/role.model.js"

const userRouter = express.Router()

/** =========================
 * Helpers
 * ========================= */

function safeJsonParse(v, fallback = null) {
  try {
    if (!v) return fallback
    if (typeof v === "object") return v
    if (typeof v !== "string") return fallback
    return JSON.parse(v)
  } catch {
    return fallback
  }
}

function isValidObjectId(v) {
  return mongoose.isValidObjectId(String(v))
}

function oid(v) {
  if (!v) return null
  if (v instanceof mongoose.Types.ObjectId) return v
  if (isValidObjectId(v)) return new mongoose.Types.ObjectId(String(v))
  return null
}

async function getMe(req) {
  const meId = oid(req?.user?._id || req?.user?.id || req?.user?.userId)
  if (!meId) return null
  return User.findById(meId).lean()
}

function isVendorUser(u) {
  return !!(u?.vendorCode && String(u.vendorCode).trim())
}

function isFirmEmployee(u) {
  return !isVendorUser(u) && !!u?.firmId
}

function isFirmRoot(u) {
  return !isVendorUser(u) && !u?.firmId
}

function getFirmRootId(u) {
  if (!u) return null
  if (isFirmEmployee(u)) return oid(u.firmId)
  if (isFirmRoot(u)) return oid(u._id)
  return null
}

async function getActiveSubscription(userId) {
  if (!userId) return null
  const now = new Date()
  return subscriptionModel
    .findOne({ userId, status: "active", endAt: { $gt: now } })
    .sort({ endAt: -1 })
    .lean()
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
  }
}

function pickFirmFull(u) {
  return {
    _id: u._id,
    name: u.name || "",
    username: u.username || "",
    email: u.email || "",
    company: u.company || {},
  }
}

function pickVendorBasic(vu, vp) {
  return {
    _id: vu._id,
    vendorCode: vu.vendorCode,
    name: vu.name || "",
    username: vu.username || "",
    email: vu.email || "",
    vendorProfile: vp
      ? {
          vendorCode: vp.vendorCode,
          name: vp.name,
          city: vp.city,
          district: vp.district,
        }
      : null,
  }
}

function pickVendorFull(vu, vp) {
  return {
    _id: vu._id,
    vendorCode: vu.vendorCode,
    name: vu.name || "",
    username: vu.username || "",
    email: vu.email || "",
    vendorProfile: vp || null, // ✅ full vendor model
  }
}

function upsertLink(arr = [], key, keyField) {
  const idx = arr.findIndex((x) => String(x?.[keyField]) === String(key))
  if (idx >= 0) return { idx, item: arr[idx] }
  return { idx: -1, item: null }
}

/**
 * connectionStatus between me and target:
 * - uses vendorFirmLinks / firmVendorLinks depending on who is me
 */
function getConnectionStatus(me, targetId) {
  const t = String(targetId)
  if (isVendorUser(me)) {
    const entry = (me.vendorFirmLinks || []).find((x) => String(x.firmUserId) === t)
    return entry || null
  }
  // firm (root/employee)
  const entry = (me.firmVendorLinks || []).find((x) => String(x.vendorUserId) === t)
  return entry || null
}

/** =========================
 * Auth (you already use tokens for permissions)
 * ========================= */
userRouter.use(authorizeTokens)

/** =========================
 * Existing routes (kept) + fixed ordering
 * ========================= */

/**
 * ✅ GET /users/me
 */
userRouter.get("/me", async (req, res, next) => {
  try {
    const me = await getMe(req)
    if (!me) throw createError("User not found", 404)
    delete me.password
    res.status(200).json(me)
  } catch (e) {
    next(e)
  }
})

/**
 * ✅ GET /users/me-or-all
 * (moved ABOVE "/:id" to avoid route collision)
 */
userRouter.get("/me-or-all", async (req, res, next) => {
  try {
    const me = await User.findById(req.user._id).populate("role", "name")
    if (!me) throw createError("User not found", 404)

    const roleName = String(me?.role?.name || "").toLowerCase()
    const isAdmin = roleName === "admin"

    if (!isAdmin) {
      const self = await User.findById(req.user._id, { password: 0 }).populate("role", "name")
      return res.status(200).json([self])
    }

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
          role: { $first: "$role.name" },
          createdBy: { $first: "$createdBy.name" },
        },
      },
      { $unset: "password" },
    ])

    return res.status(200).json(users)
  } catch (error) {
    next(error)
  }
})

/**
 * ✅ POST /users (Admin create)
 * - now supports firm/company fields + firmId + vendorCode safely
 * - won't crash if missing fields
 */
userRouter.post(
  "/",
  authorizePermissions(PERMISSIONS.ACCESS_CONTROL),
  (req, res, next) => {
    req.params.id = new Types.ObjectId().toString()
    next()
  },
  upload.single("digitalSignature"),
  async (req, res, next) => {
    try {
      const body = req.body || {}
      const { username, password, name, role, permissions, ...rest } = body

      if (!username || !password || !name) {
        throw createError("username, password, name are required", 400)
      }

      const companyObj =
        safeJsonParse(body.company, null) ||
        {
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
        }

      // ✅ If creating a firm root and company.name missing, auto-fill (prevents validation fail)
      const vendorCode = body.vendorCode ? String(body.vendorCode).trim() : null
      const firmId = oid(body.firmId)

      if (!vendorCode && !firmId && !companyObj?.name) {
        companyObj.name = String(name || "").trim()
      }

      if (req.file) rest.digitalSignature = req.file.filename

      const hashedPassword = await hashAsync(password, 10)

      const newUser = new User({
        _id: req.params.id,
        username: String(username).trim(),
        password: hashedPassword,
        passwordStatus: "temporary",
        createdBy: req?.user?._id,
        name: String(name).trim(),
        permissions, // kept (even if schema ignores)
        role: role || null,

        // ✅ new fields
        vendorCode: vendorCode || null,
        firmId: firmId || null,
        company: companyObj,

        ...rest,
      })

      await newUser.save()

      const json = newUser.toJSON()
      delete json.password
      res.status(201).json(json)
    } catch (error) {
      next(error)
    }
  }
)

/**
 * ✅ POST /users/list (datatable)
 * - Adds optional filters: type, industry, companyName
 */
userRouter.post("/list", async (req, res, next) => {
  try {
    const { query, type, industry, companyName, ...params } = req.body || {}

    params.matchQuery = [{ $match: { status: 1 } }]

    // search query
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
      })
    }

    // type filter
    if (type) {
      const t = String(type).toLowerCase()
      if (t === "vendor") params.matchQuery.push({ $match: { vendorCode: { $ne: null } } })
      if (t === "firm") params.matchQuery.push({ $match: { vendorCode: null, firmId: null } })
      if (t === "employee") params.matchQuery.push({ $match: { vendorCode: null, firmId: { $ne: null } } })
    }

    if (industry) {
      params.matchQuery.push({
        $match: { "company.industry": { $regex: String(industry), $options: "i" } },
      })
    }

    if (companyName) {
      params.matchQuery.push({
        $match: { "company.name": { $regex: String(companyName), $options: "i" } },
      })
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
    ])

    res.status(200).send(response)
  } catch (error) {
    next(error)
  }
})

/**
 * ✅ GET /users (admin style list)
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
    ])
    res.status(200).json(users)
  } catch (error) {
    next(error)
  }
})

/**
 * ✅ GET /users/po-vendors (kept)
 */
userRouter.get("/po-vendors", async (req, res, next) => {
  try {
    const roles = await roleModel.find(
      { permissions: { $in: [PERMISSIONS.AUTHORIZE_PO] } },
      { _id: 1 }
    )

    const users = await User.aggregate([
      {
        $match: {
          role: { $in: roles.map((i) => i._id) },
        },
      },
      { $project: { _id: 1, username: 1, name: 1 } },
    ])

    res.status(200).json(users)
  } catch (error) {
    next(error)
  }
})

/**
 * ✅ PUT /users/:id (Admin update)
 * - supports company, firmId safely
 * - does not overwrite fields if not provided
 */
userRouter.put(
  "/:id",
  authorizePermissions(PERMISSIONS.ACCESS_CONTROL),
  upload.single("digitalSignature"),
  async (req, res, next) => {
    try {
      const body = req.body || {}

      let digitalSignature = body.digitalSignature

      if (req.file) {
        digitalSignature = req.file.filename

        const currData = await User.findById(req.params.id, { digitalSignature: 1 })
        if (currData?.digitalSignature) {
          await fs.rm(`uploads/${req.params.id}/${currData.digitalSignature}`, { force: true })
        }
      }

      const companyObj = safeJsonParse(body.company, null)
      const firmId = oid(body.firmId)

      const updatedData = {}

      // only set if provided
      const setIf = (k, v) => {
        if (v !== undefined) updatedData[k] = v
      }

      setIf("username", body.username ? String(body.username).trim() : undefined)
      setIf("name", body.name ? String(body.name).trim() : undefined)
      setIf("vendorCode", body.vendorCode !== undefined ? (String(body.vendorCode).trim() || null) : undefined)
      setIf("email", body.email !== undefined ? String(body.email).trim() : undefined)
      setIf("role", body.role !== undefined ? body.role : undefined)
      setIf("digitalSignature", digitalSignature !== undefined ? digitalSignature : undefined)
      setIf("firmId", body.firmId !== undefined ? firmId : undefined)

      // patch company safely
      if (companyObj) {
        updatedData.company = {
          ...(companyObj || {}),
        }
      } else {
        // accept flat fields if sent
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
        }
        const any = Object.values(flatCompany).some((x) => x !== undefined)
        if (any) updatedData.company = flatCompany
      }

      const user = await User.findByIdAndUpdate(req.params.id, { $set: updatedData }, { new: true })
      if (!user) throw createError("User not found", 404)

      const json = user.toJSON()
      delete json.password
      res.status(200).json(json)
    } catch (error) {
      next(error)
    }
  }
)

/**
 * ✅ DELETE /users/:id (kept)
 */
userRouter.delete("/:id", authorizePermissions(PERMISSIONS.ACCESS_CONTROL), async (req, res, next) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id)
    if (!user) throw createError("User not found", 404)
    if (user.digitalSignature) await fs.rm("uploads/" + req.params.id, { recursive: true, force: true })
    res.status(200).json({ message: "User deleted successfully" })
  } catch (error) {
    next(error)
  }
})

/**
 * ✅ POST /users/reset-password (kept)
 */
userRouter.post("/reset-password", async (req, res, next) => {
  try {
    const { password } = req.body || {}
    const user = await User.findById(req.user._id)
    if (!user) throw createError("User not found", 404)

    const resetBySelf = String(req.user._id) === String(user._id)

    if (!password) throw createError("password is required", 400)
    if ((await compareAsync(password, user.password)) && resetBySelf) {
      throw createError("New password must be different from previous password.", 405)
    }

    user.password = await hashAsync(password, 10)
    user.passwordStatus = resetBySelf ? "permanent" : "temporary"
    await user.save()

    res.status(200).json({ message: "Password reset successfully" })
  } catch (error) {
    next(error)
  }
})

/** =========================================================
 * ✅ NEW: Firm seat users (employees under firm subscription)
 * ========================================================= */

/**
 * GET /users/firm/employees
 * - firm root can view its employees
 * - firm employee can also view siblings (under same firm root)
 */
userRouter.get("/firm/employees", async (req, res, next) => {
  try {
    const me = await getMe(req)
    if (!me) throw createError("User not found", 404)
    if (isVendorUser(me)) throw createError("Vendors cannot access firm employees", 403)

    const firmRootId = getFirmRootId(me)
    if (!firmRootId) throw createError("Invalid firm context", 400)

    const employees = await User.find(
      { firmId: firmRootId, status: 1 },
      { password: 0 }
    ).sort({ createdAt: -1 })

    res.json({ ok: true, firmId: firmRootId, employees })
  } catch (e) {
    next(e)
  }
})

/**
 * POST /users/firm/employees
 * - only firm ROOT can create employees
 * - optional seat enforcement via subscription.notes.seats
 * body: { username, password, name, email?, role? }
 */
userRouter.post("/firm/employees", async (req, res, next) => {
  try {
    const me = await getMe(req)
    if (!me) throw createError("User not found", 404)
    if (!isFirmRoot(me)) throw createError("Only firm root can create employees", 403)

    const { username, password, name, email, role } = req.body || {}
    if (!username || !password || !name) {
      throw createError("username, password, name are required", 400)
    }

    // ✅ seat check (uses firm root subscription)
    const activeSub = await getActiveSubscription(me._id)
    if (!activeSub) throw createError("Active subscription required to add employees", 402)

    const seatsAllowed = Number(activeSub?.notes?.seats || 0) // if not set => treat as unlimited
    if (seatsAllowed > 0) {
      const used = await User.countDocuments({ firmId: me._id, status: 1 })
      if (used >= seatsAllowed) {
        throw createError(`Seat limit reached (${seatsAllowed}). Upgrade plan to add more users.`, 402)
      }
    }

    const hashedPassword = await hashAsync(password, 10)

    const employee = await User.create({
      _id: new Types.ObjectId().toString(),
      firmId: me._id,
      username: String(username).trim(),
      password: hashedPassword,
      passwordStatus: "temporary",
      createdBy: me._id,
      name: String(name).trim(),
      email: email ? String(email).trim() : "",
      role: role || null,
      status: 1,
      // company not required for employee (schema handles)
    })

    const json = employee.toJSON()
    delete json.password
    res.status(201).json({ ok: true, employee: json })
  } catch (e) {
    next(e)
  }
})

/** =========================================================
 * ✅ NEW: Connect / Tie / Untie (two-side like Facebook)
 * ========================================================= */

/**
 * POST /users/connections/request
 * - firm requests vendor OR vendor requests firm
 * body examples:
 *  - firm -> vendor: { vendorCode: "VND0001" } OR { targetUserId: "<vendorUserId>" }
 *  - vendor -> firm: { targetUserId: "<firmUserId>" } OR { firmUsername: "abc" }
 */
userRouter.post("/connections/request", async (req, res, next) => {
  try {
    const me = await getMe(req)
    if (!me) throw createError("User not found", 404)

    const body = req.body || {}
    let target = null

    if (isVendorUser(me)) {
      // vendor requesting a firm
      if (body.targetUserId && isValidObjectId(body.targetUserId)) {
        target = await User.findById(body.targetUserId).lean()
      } else if (body.firmUsername) {
        target = await User.findOne({ username: String(body.firmUsername).trim(), status: 1 }).lean()
      } else {
        throw createError("targetUserId or firmUsername required", 400)
      }

      if (!target) throw createError("Firm not found", 404)
      if (isVendorUser(target)) throw createError("Vendors cannot connect to vendors", 400)
    } else {
      // firm requesting a vendor
      if (body.targetUserId && isValidObjectId(body.targetUserId)) {
        target = await User.findById(body.targetUserId).lean()
      } else if (body.vendorCode) {
        target = await User.findOne({ vendorCode: String(body.vendorCode).trim(), status: 1 }).lean()
      } else {
        throw createError("targetUserId or vendorCode required", 400)
      }

      if (!target) throw createError("Vendor not found", 404)
      if (!isVendorUser(target)) throw createError("Firms cannot connect to firms", 400)
    }

    const now = new Date()

    // ensure link exists on BOTH sides
    if (isVendorUser(me)) {
      // me = vendor, target = firm
      const meDoc = await User.findById(me._id)
      const tDoc = await User.findById(target._id)
      if (!meDoc || !tDoc) throw createError("User not found", 404)

      // add/update vendor side
      const a = upsertLink(meDoc.vendorFirmLinks || [], target._id, "firmUserId")
      if (a.idx >= 0) {
        // keep status if already active/pending
      } else {
        meDoc.vendorFirmLinks = [
          ...(meDoc.vendorFirmLinks || []),
          { firmUserId: target._id, status: "pending", activeUntil: null, createdAt: now },
        ]
      }

      // add/update firm side (firm root id if employee)
      const firmRootId = getFirmRootId(tDoc) || tDoc._id
      const firmRoot = await User.findById(firmRootId)
      if (!firmRoot) throw createError("Firm root not found", 404)

      const b = upsertLink(firmRoot.firmVendorLinks || [], me._id, "vendorUserId")
      if (b.idx < 0) {
        firmRoot.firmVendorLinks = [
          ...(firmRoot.firmVendorLinks || []),
          { vendorUserId: me._id, status: "pending", activeUntil: null, createdAt: now },
        ]
      }

      await meDoc.save()
      await firmRoot.save()

      return res.json({ ok: true, message: "Request sent", targetUserId: target._id })
    } else {
      // me = firm, target = vendor
      const firmRootId = getFirmRootId(me)
      if (!firmRootId) throw createError("Invalid firm context", 400)

      const firmRoot = await User.findById(firmRootId)
      const vendorUser = await User.findById(target._id)
      if (!firmRoot || !vendorUser) throw createError("User not found", 404)

      const a = upsertLink(firmRoot.firmVendorLinks || [], vendorUser._id, "vendorUserId")
      if (a.idx < 0) {
        firmRoot.firmVendorLinks = [
          ...(firmRoot.firmVendorLinks || []),
          { vendorUserId: vendorUser._id, status: "pending", activeUntil: null, createdAt: now },
        ]
      }

      const b = upsertLink(vendorUser.vendorFirmLinks || [], firmRoot._id, "firmUserId")
      if (b.idx < 0) {
        vendorUser.vendorFirmLinks = [
          ...(vendorUser.vendorFirmLinks || []),
          { firmUserId: firmRoot._id, status: "pending", activeUntil: null, createdAt: now },
        ]
      }

      await firmRoot.save()
      await vendorUser.save()

      return res.json({ ok: true, message: "Request sent", targetUserId: target._id })
    }
  } catch (e) {
    next(e)
  }
})

/**
 * POST /users/connections/respond
 * - accept/decline from the RECEIVER side
 * body: { targetUserId, action: "accept"|"decline"|"block" }
 *
 * ✅ On accept:
 * - sets status="active" on both sides
 * - sets activeUntil = payer subscription endAt
 *   (vendor-pays model: vendor subscription governs link validity)
 */
userRouter.post("/connections/respond", async (req, res, next) => {
  try {
    const me = await getMe(req)
    if (!me) throw createError("User not found", 404)

    const { targetUserId, action } = req.body || {}
    if (!targetUserId || !isValidObjectId(targetUserId)) throw createError("targetUserId required", 400)

    const act = String(action || "").toLowerCase()
    if (!["accept", "decline", "block"].includes(act)) throw createError("Invalid action", 400)

    const target = await User.findById(targetUserId)
    const meDoc = await User.findById(me._id)

    if (!target || !meDoc) throw createError("User not found", 404)

    const now = new Date()

    // vendor responds to firm OR firm responds to vendor
    if (isVendorUser(meDoc)) {
      // me=vendor, target must be firm
      if (isVendorUser(target)) throw createError("Vendors cannot respond to vendors", 400)

      const firmRootId = getFirmRootId(target) || target._id
      const firmRoot = await User.findById(firmRootId)
      if (!firmRoot) throw createError("Firm root not found", 404)

      // find pending links
      const vIdx = (meDoc.vendorFirmLinks || []).findIndex((x) => String(x.firmUserId) === String(firmRoot._id))
      const fIdx = (firmRoot.firmVendorLinks || []).findIndex((x) => String(x.vendorUserId) === String(meDoc._id))

      if (vIdx < 0 || fIdx < 0) throw createError("No pending request found", 404)

      if (act === "accept") {
        // ✅ vendor subscription governs link validity
        const sub = await getActiveSubscription(meDoc._id)
        if (!sub) throw createError("Vendor subscription required to activate connection", 402)

        meDoc.vendorFirmLinks[vIdx].status = "active"
        meDoc.vendorFirmLinks[vIdx].activeUntil = sub.endAt

        firmRoot.firmVendorLinks[fIdx].status = "active"
        firmRoot.firmVendorLinks[fIdx].activeUntil = sub.endAt
      } else {
        const status = act === "block" ? "blocked" : "removed"
        meDoc.vendorFirmLinks[vIdx].status = status
        meDoc.vendorFirmLinks[vIdx].activeUntil = null

        firmRoot.firmVendorLinks[fIdx].status = status
        firmRoot.firmVendorLinks[fIdx].activeUntil = null
      }

      await meDoc.save()
      await firmRoot.save()

      return res.json({ ok: true, message: `Request ${act}ed` })
    } else {
      // me=firm, target must be vendor
      if (!isVendorUser(target)) throw createError("Firms cannot respond to firms", 400)

      const firmRootId = getFirmRootId(meDoc)
      if (!firmRootId) throw createError("Invalid firm context", 400)

      const firmRoot = await User.findById(firmRootId)
      const vendorUser = await User.findById(target._id)
      if (!firmRoot || !vendorUser) throw createError("User not found", 404)

      const fIdx = (firmRoot.firmVendorLinks || []).findIndex((x) => String(x.vendorUserId) === String(vendorUser._id))
      const vIdx = (vendorUser.vendorFirmLinks || []).findIndex((x) => String(x.firmUserId) === String(firmRoot._id))

      if (fIdx < 0 || vIdx < 0) throw createError("No pending request found", 404)

      if (act === "accept") {
        // ✅ vendor subscription governs link validity (vendor pays)
        const sub = await getActiveSubscription(vendorUser._id)
        if (!sub) throw createError("Vendor subscription required to activate connection", 402)

        firmRoot.firmVendorLinks[fIdx].status = "active"
        firmRoot.firmVendorLinks[fIdx].activeUntil = sub.endAt

        vendorUser.vendorFirmLinks[vIdx].status = "active"
        vendorUser.vendorFirmLinks[vIdx].activeUntil = sub.endAt
      } else {
        const status = act === "block" ? "blocked" : "removed"
        firmRoot.firmVendorLinks[fIdx].status = status
        firmRoot.firmVendorLinks[fIdx].activeUntil = null

        vendorUser.vendorFirmLinks[vIdx].status = status
        vendorUser.vendorFirmLinks[vIdx].activeUntil = null
      }

      await firmRoot.save()
      await vendorUser.save()

      return res.json({ ok: true, message: `Request ${act}ed` })
    }
  } catch (e) {
    next(e)
  }
})

/**
 * POST /users/connections/remove
 * body: { targetUserId }
 */
userRouter.post("/connections/remove", async (req, res, next) => {
  try {
    const me = await getMe(req)
    if (!me) throw createError("User not found", 404)

    const { targetUserId } = req.body || {}
    if (!targetUserId || !isValidObjectId(targetUserId)) throw createError("targetUserId required", 400)

    const meDoc = await User.findById(me._id)
    const target = await User.findById(targetUserId)
    if (!meDoc || !target) throw createError("User not found", 404)

    // vendor <-> firm only
    if (isVendorUser(meDoc) && isVendorUser(target)) throw createError("Not allowed", 400)
    if (!isVendorUser(meDoc) && !isVendorUser(target)) throw createError("Not allowed", 400)

    let firmRoot = null
    let vendorUser = null

    if (isVendorUser(meDoc)) {
      vendorUser = meDoc
      firmRoot = await User.findById(getFirmRootId(target) || target._id)
    } else {
      firmRoot = await User.findById(getFirmRootId(meDoc) || meDoc._id)
      vendorUser = target
    }

    if (!firmRoot || !vendorUser) throw createError("Invalid link", 400)

    const fIdx = (firmRoot.firmVendorLinks || []).findIndex((x) => String(x.vendorUserId) === String(vendorUser._id))
    const vIdx = (vendorUser.vendorFirmLinks || []).findIndex((x) => String(x.firmUserId) === String(firmRoot._id))

    if (fIdx >= 0) {
      firmRoot.firmVendorLinks[fIdx].status = "removed"
      firmRoot.firmVendorLinks[fIdx].activeUntil = null
    }
    if (vIdx >= 0) {
      vendorUser.vendorFirmLinks[vIdx].status = "removed"
      vendorUser.vendorFirmLinks[vIdx].activeUntil = null
    }

    await firmRoot.save()
    await vendorUser.save()

    return res.json({ ok: true, message: "Connection removed" })
  } catch (e) {
    next(e)
  }
})

/**
 * GET /users/connections
 * - returns my connections list (minimal target details)
 */
userRouter.get("/connections", async (req, res, next) => {
  try {
    const me = await getMe(req)
    if (!me) throw createError("User not found", 404)

    if (isVendorUser(me)) {
      const firmIds = (me.vendorFirmLinks || [])
        .filter((x) => x.status !== "removed")
        .map((x) => x.firmUserId)

      const firms = await User.find({ _id: { $in: firmIds }, status: 1 }).lean()

      return res.json({
        ok: true,
        type: "vendor",
        connections: (me.vendorFirmLinks || []).map((l) => ({
          ...l,
          firm: pickFirmLimited(firms.find((f) => String(f._id) === String(l.firmUserId)) || {}),
        })),
      })
    }

    const firmRootId = getFirmRootId(me)
    const firmRoot = await User.findById(firmRootId).lean()

    const vendorIds = (firmRoot?.firmVendorLinks || [])
      .filter((x) => x.status !== "removed")
      .map((x) => x.vendorUserId)

    const vendors = await User.find({ _id: { $in: vendorIds }, status: 1 }).lean()
    const vendorCodes = vendors.map((v) => v.vendorCode).filter(Boolean)

    const vendorProfiles = await vendorModel.find({ vendorCode: { $in: vendorCodes } }).lean()
    const vpMap = new Map(vendorProfiles.map((x) => [x.vendorCode, x]))

    return res.json({
      ok: true,
      type: "firm",
      connections: (firmRoot?.firmVendorLinks || []).map((l) => {
        const vu = vendors.find((v) => String(v._id) === String(l.vendorUserId))
        return {
          ...l,
          vendor: vu ? pickVendorBasic(vu, vpMap.get(vu.vendorCode)) : null,
        }
      }),
    })
  } catch (e) {
    next(e)
  }
})

/** =========================================================
 * ✅ NEW: Common directory (same page for firm/vendor)
 * ========================================================= */

/**
 * GET /users/directory
 * Query:
 * - search=...
 * - discover=1 (optional; if 0, only shows connected vendors/firms)
 *
 * Rules:
 * - Vendor can see ONLY firms (limited unless connected)
 * - Firm can see ONLY vendors (full only if connected)
 */
userRouter.get("/directory", async (req, res, next) => {
  try {
    const me = await getMe(req)
    if (!me) throw createError("User not found", 404)

    const search = String(req.query.search || "").trim()
    const discover = String(req.query.discover || "0") === "1"

    const now = new Date()

    if (isVendorUser(me)) {
      // vendor -> firms only
      const baseMatch = {
        status: 1,
        vendorCode: null, // firms only
      }

      const firmQuery = { ...baseMatch }
      if (search) {
        firmQuery.$or = [
          { name: { $regex: search, $options: "i" } },
          { username: { $regex: search, $options: "i" } },
          { "company.name": { $regex: search, $options: "i" } },
          { "company.industry": { $regex: search, $options: "i" } },
        ]
      }

      // If discover=false: only connected/pending firms
      let allowFirmIds = null
      if (!discover) {
        allowFirmIds = (me.vendorFirmLinks || [])
          .filter((x) => x.status === "active" || x.status === "pending")
          .map((x) => x.firmUserId)
      }

      const firms = await User.find(
        allowFirmIds ? { ...firmQuery, _id: { $in: allowFirmIds } } : firmQuery
      ).lean()

      // vendor sees LIMITED firm details by default
      // if connected active, you may show "more", but still keep limited as you asked
      const data = firms.map((f) => {
        const link = (me.vendorFirmLinks || []).find((x) => String(x.firmUserId) === String(f._id)) || null
        const isActive = link?.status === "active" && (!link?.activeUntil || new Date(link.activeUntil) > now)
        return {
          type: "firm",
          connection: link ? { status: link.status, activeUntil: link.activeUntil } : null,
          firm: isActive ? pickFirmLimited(f) : pickFirmLimited(f),
        }
      })

      return res.json({ ok: true, viewerType: "vendor", data })
    }

    // firm -> vendors only (firm root context)
    const firmRootId = getFirmRootId(me)
    if (!firmRootId) throw createError("Invalid firm context", 400)

    const firmRoot = await User.findById(firmRootId).lean()
    const firmLinks = firmRoot?.firmVendorLinks || []

    // If discover=false: only linked vendors (pending/active)
    let allowVendorIds = null
    if (!discover) {
      allowVendorIds = firmLinks
        .filter((x) => x.status === "active" || x.status === "pending")
        .map((x) => x.vendorUserId)
    }

    const vendorQuery = {
      status: 1,
      vendorCode: { $ne: null }, // vendors only
    }

    if (search) {
      vendorQuery.$or = [
        { name: { $regex: search, $options: "i" } },
        { username: { $regex: search, $options: "i" } },
        { vendorCode: { $regex: search, $options: "i" } },
      ]
    }

    const vendorUsers = await User.find(
      allowVendorIds ? { ...vendorQuery, _id: { $in: allowVendorIds } } : vendorQuery
    ).lean()

    const vendorCodes = vendorUsers.map((v) => v.vendorCode).filter(Boolean)
    const vendorProfiles = await vendorModel.find({ vendorCode: { $in: vendorCodes } }).lean()
    const vpMap = new Map(vendorProfiles.map((x) => [x.vendorCode, x]))

    const data = vendorUsers.map((vu) => {
      const link = firmLinks.find((x) => String(x.vendorUserId) === String(vu._id)) || null
      const isActive = link?.status === "active" && (!link?.activeUntil || new Date(link.activeUntil) > now)

      // firm can see FULL vendor details only when connected active
      return {
        type: "vendor",
        connection: link ? { status: link.status, activeUntil: link.activeUntil } : null,
        vendor: isActive ? pickVendorFull(vu, vpMap.get(vu.vendorCode)) : pickVendorBasic(vu, vpMap.get(vu.vendorCode)),
      }
    })

    return res.json({ ok: true, viewerType: "firm", data })
  } catch (e) {
    next(e)
  }
})

/**
 * ✅ GET /users/:id (kept)
 * (placed at bottom to not steal /me-or-all, /directory etc)
 */
userRouter.get("/:id", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id, { password: 0 })
    if (!user) throw createError("User not found", 404)
    res.status(200).json(user)
  } catch (error) {
    next(error)
  }
})

export default userRouter