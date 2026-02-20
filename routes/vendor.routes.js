// routes/vendor.routes.js
import express from "express";
import bcrypt from "bcryptjs";
import userModel from "../models/user.model.js";
import counterModel from "../models/counter.model.js";
import { importVendors } from "../lib/importVendors.js";

const vendorRouter = express.Router();

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
  // ✅ if seq becomes 10000, width becomes 5 automatically
  const width = Math.max(minLen, s.length);
  return s.padStart(width, "0");
}

function parseSeqFromVendorCode(code) {
  if (!code || typeof code !== "string") return 0;
  const m = code.match(new RegExp(`^${VENDOR_PREFIX}(\\d+)$`));
  if (!m?.[1]) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * ✅ Get max sequence in DB numerically (safe even after 9999)
 * ✅ NOW reads from users collection (vendor users have vendorCode)
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

/**
 * Ensures counter.seq >= max existing VNDxxxx in users collection.
 * Prevents duplicates even if counter got reset / DB migrated / imported vendors exist.
 */
async function ensureVendorCounterInitialized() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const maxSeq = await getMaxVendorSeq();

    // ✅ This requires counter _id to be STRING
    await counterModel.findByIdAndUpdate(
      COUNTER_ID,
      {
        $setOnInsert: { _id: COUNTER_ID },
        $max: { seq: maxSeq },
      },
      { upsert: true, new: true }
    );
  })();

  return initPromise;
}

async function nextVendorCode() {
  await ensureVendorCounterInitialized();

  const counter = await counterModel.findByIdAndUpdate(
    COUNTER_ID,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  const seq = counter?.seq || 1;
  return `${VENDOR_PREFIX}${pad(seq, PAD_LEN)}`; // VND0001, VND0002, ...
}

/** =========================
 *  Existing routes (endpoints unchanged)
 *  ========================= */

vendorRouter.get("/import", async (req, res, next) => {
  try {
    /**
     * ✅ IMPORTANT:
     * Your importVendors() must now import into users collection (vendor users).
     * If your lib supports passing a model, this will work; if it ignores args, it's still safe.
     */
    await importVendors(userModel);

    // ✅ after import, re-init counter (important if import adds bigger vendorCodes)
    initPromise = null;
    await ensureVendorCounterInitialized();

    res.status(200).send({ success: true });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /vendor/list
 * - Always returns ARRAY
 * - Optional:
 *   - vendorCode
 *   - search
 */
vendorRouter.get("/list", async (req, res, next) => {
  try {
    const { vendorCode, search } = req.query;

    const match = {
      // ✅ only vendors (since users collection also has firms)
      vendorCode: { $exists: true, $nin: [null, ""] },
    };

    if (vendorCode) {
      match.vendorCode = String(vendorCode).trim();
    }

    if (search) {
      const s = String(search).trim();
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

vendorRouter.get("/basic-details", async (req, res, next) => {
  try {
    const data = await userModel.find(
      { vendorCode: { $exists: true, $nin: [null, ""] } },
      { vendorCode: 1, name: 1, contactPerson: 1, street: 1 }
    );
    res.status(200).send(data);
  } catch (error) {
    next(error);
  }
});

vendorRouter.get("/values", async (req, res, next) => {
  try {
    const { search } = req.query;

    const match = {
      vendorCode: { $exists: true, $nin: [null, ""] },
    };

    if (search) {
      const s = String(search).trim();
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
      }))
    );
  } catch (error) {
    next(error);
  }
});

/** =========================
 *  ✅ POST /vendor (auto vendorCode)
 *  - NOW creates a vendor USER
 *  - username = vendorCode
 *  - password = vendorCode (stored hashed)
 *  ========================= */
vendorRouter.post("/", async (req, res, next) => {
  try {
    const payload = req.body || {};

    const name = String(payload.name || "").trim();
    if (!name) {
      return res.status(400).send({ success: false, message: "name is required." });
    }

    const contactPerson = Array.isArray(payload.contactPerson) ? payload.contactPerson : [];

    // try pull email from payload or first contactPerson
    const email =
      String(payload.email || "").trim().toLowerCase() ||
      String(contactPerson?.[0]?.email || "").trim().toLowerCase() ||
      "";

    let created = null;

    // ✅ retry is good safety (handles rare collision or concurrent import)
    for (let attempt = 0; attempt < 5; attempt++) {
      const vendorCode = await nextVendorCode();

      try {
        const username = vendorCode;
        const passwordHash = await bcrypt.hash(vendorCode, 10);

        created = await userModel.create({
          ...payload,

          // ✅ vendor flags
          vendorCode,
          firmId: null,

          // ✅ auth
          username,
          password: passwordHash,
          passwordStatus: "permanent",

          // ✅ main display
          name,
          email,

          // ✅ normalize
          contactPerson,

          // ✅ audit
          createdBy: req?.user?._id || req?.user?.id || null,
          status: 1,
        });

        break;
      } catch (e) {
        if (e?.code === 11000) continue; // duplicate key
        throw e;
      }
    }

    if (!created) {
      return res.status(500).send({
        success: false,
        message: "Unable to generate unique vendorCode. Please try again.",
      });
    }

    res.status(201).send({ success: true, data: created });
  } catch (error) {
    next(error);
  }
});

/** =========================
 *  ✅ PUT /vendor/:vendorCode (update)
 *  - Updates vendor USER doc by vendorCode
 *  ========================= */
vendorRouter.put("/:vendorCode", async (req, res, next) => {
  try {
    const vendorCode = String(req.params.vendorCode || "").trim();
    if (!vendorCode) {
      return res.status(400).send({
        success: false,
        message: "vendorCode param is required.",
      });
    }

    const payload = req.body || {};

    // Don't allow vendorCode change
    if (payload.vendorCode && String(payload.vendorCode).trim() !== vendorCode) {
      return res.status(400).send({
        success: false,
        message: "vendorCode cannot be changed.",
      });
    }

    // Keep vendor login identity stable
    if (payload.username && String(payload.username).trim() !== vendorCode) {
      return res.status(400).send({
        success: false,
        message: "username cannot be changed for vendor accounts.",
      });
    }

    // Don't allow changing firmId from vendor routes
    if (payload.firmId) delete payload.firmId;

    // Don't allow changing password here (create a dedicated endpoint if needed)
    if (payload.password) delete payload.password;

    if (payload.contactPerson && !Array.isArray(payload.contactPerson)) {
      return res.status(400).send({
        success: false,
        message: "contactPerson must be an array.",
      });
    }

    const updated = await userModel.findOneAndUpdate(
      { vendorCode, vendorCode: { $exists: true, $nin: [null, ""] } },
      { $set: payload },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).send({ success: false, message: "Vendor not found." });
    }

    res.status(200).send({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

export default vendorRouter;