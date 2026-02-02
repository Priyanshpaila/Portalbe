import express from "express";
import vendorModel from "../models/vendor.model.js";
import preapprovedVendorModel from "../models/preapprovedVendor.model.js";
import counterModel from "../models/counter.model.js";

const preapprovedVendorRouter = express.Router();

/** =========================
 *  vendorCode generator (VND0001...)
 *  ========================= */
const COUNTER_ID = "vendorCode";
const VENDOR_PREFIX = "VND";
const PAD_LEN = 4;

function pad(num, len) {
  return String(num).padStart(len, "0");
}

function parseSeqFromVendorCode(code) {
  if (!code || typeof code !== "string") return 0;
  if (!code.startsWith(VENDOR_PREFIX)) return 0;
  const n = parseInt(code.slice(VENDOR_PREFIX.length), 10);
  return Number.isFinite(n) ? n : 0;
}

let initPromise = null;

async function ensureVendorCounterInitialized() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const maxDoc = await vendorModel
      .findOne({ vendorCode: new RegExp(`^${VENDOR_PREFIX}\\d+$`) })
      .sort({ vendorCode: -1 })
      .select({ vendorCode: 1 })
      .lean();

    const maxSeq = maxDoc ? parseSeqFromVendorCode(maxDoc.vendorCode) : 0;

    await counterModel.findByIdAndUpdate(
      COUNTER_ID,
      { $max: { seq: maxSeq } },
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
  return `${VENDOR_PREFIX}${pad(seq, PAD_LEN)}`;
}

/** =========================
 *  Routes
 *  ========================= */

// ✅ Create preapproved vendor (pending by default)
preapprovedVendorRouter.post("/", async (req, res, next) => {
  try {
    const payload = req.body || {};

    const name = String(payload.name || "").trim();
    if (!name) {
      return res.status(400).send({ success: false, message: "name is required" });
    }

    const created = await preapprovedVendorModel.create({
      ...payload,
      name,
      status: "pending",
      contactPerson: Array.isArray(payload.contactPerson) ? payload.contactPerson : [],
    });

    res.status(201).send({ success: true, data: created });
  } catch (err) {
    next(err);
  }
});

// ✅ List preapproved vendors
preapprovedVendorRouter.get("/list", async (req, res, next) => {
  try {
    const { status, search } = req.query;

    const match = {};
    if (status) match.status = String(status).toLowerCase();

    if (search) {
      const s = String(search).trim();
      match.$or = [
        { name: { $regex: s, $options: "i" } },
        { gstin: { $regex: s, $options: "i" } },
        { panNumber: { $regex: s, $options: "i" } },
      ];
    }

    const data = await preapprovedVendorModel.find(match).sort({ createdAt: -1 });
    res.status(200).send({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ✅ Update preapproved vendor (only if still pending)
preapprovedVendorRouter.put("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const payload = req.body || {};

    // Don't allow status to be changed here
    if (payload.status) delete payload.status;

    const updated = await preapprovedVendorModel.findOneAndUpdate(
      { _id: id, status: "pending" },
      { $set: payload },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).send({
        success: false,
        message: "Not found OR already approved (cannot edit).",
      });
    }

    res.status(200).send({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// ✅ Approve: push to main vendor collection (auto vendorCode) + mark approved
preapprovedVendorRouter.post("/:id/approve", async (req, res, next) => {
  try {
    const id = req.params.id;

    // fetch doc
    const pre = await preapprovedVendorModel.findById(id);
    if (!pre) return res.status(404).send({ success: false, message: "Preapproved vendor not found" });

    if (pre.status === "approved") {
      return res.status(400).send({ success: false, message: "Already approved" });
    }

    // prepare vendor payload (remove status + mongo fields)
    const obj = pre.toObject();
    delete obj._id;
    delete obj.__v;
    delete obj.status;
    delete obj.createdAt;
    delete obj.updatedAt;

    // create in main vendor with auto vendorCode
    let createdVendor = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const vendorCode = await nextVendorCode();
      try {
        createdVendor = await vendorModel.create({
          ...obj,
          vendorCode, // ✅ auto generated here
        });
        break;
      } catch (e) {
        // if somehow collision happens, try next
        if (e?.code === 11000) continue;
        throw e;
      }
    }

    if (!createdVendor) {
      return res.status(500).send({
        success: false,
        message: "Failed to create vendor with unique vendorCode",
      });
    }

    // mark preapproved as approved
    pre.status = "approved";
    await pre.save();

    res.status(200).send({
      success: true,
      message: "Vendor approved and moved to vendor master",
      vendor: createdVendor,
    });
  } catch (err) {
    next(err);
  }
});

export default preapprovedVendorRouter;
