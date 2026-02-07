import express from "express";
import vendorModel from "../models/vendor.model.js";
import preapprovedVendorModel from "../models/preapprovedVendor.model.js";
import counterModel from "../models/counter.model.js";

const preapprovedVendorRouter = express.Router();

/** =========================
 *  vendorCode generator (VND0001...)
 *  ========================= */
const VENDOR_COUNTER_ID = "vendorCode";
const VENDOR_PREFIX = "VND";
const VENDOR_PAD_LEN = 4;

/** =========================
 *  companyCode generator (CN00001...)
 *  ========================= */
const COMPANY_COUNTER_ID = "companyCode";
const COMPANY_PREFIX = "CN";
const COMPANY_PAD_LEN = 5;

function pad(num, len) {
  return String(num).padStart(len, "0");
}

function parseSeq(code, prefix) {
  if (!code || typeof code !== "string") return 0;
  if (!code.startsWith(prefix)) return 0;
  const n = parseInt(code.slice(prefix.length), 10);
  return Number.isFinite(n) ? n : 0;
}

let initVendorPromise = null;
let initCompanyPromise = null;

async function ensureVendorCounterInitialized() {
  if (initVendorPromise) return initVendorPromise;

  initVendorPromise = (async () => {
    const maxDoc = await vendorModel
      .findOne({ vendorCode: new RegExp(`^${VENDOR_PREFIX}\\d+$`) })
      .sort({ vendorCode: -1 })
      .select({ vendorCode: 1 })
      .lean();

    const maxSeq = maxDoc ? parseSeq(maxDoc.vendorCode, VENDOR_PREFIX) : 0;

    await counterModel.findByIdAndUpdate(
      VENDOR_COUNTER_ID,
      { $max: { seq: maxSeq } },
      { upsert: true, new: true }
    );
  })();

  return initVendorPromise;
}

async function nextVendorCode() {
  await ensureVendorCounterInitialized();

  const counter = await counterModel.findByIdAndUpdate(
    VENDOR_COUNTER_ID,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  const seq = counter?.seq || 1;
  return `${VENDOR_PREFIX}${pad(seq, VENDOR_PAD_LEN)}`;
}

/**
 * Company counter init should consider BOTH collections
 * (because companyCode exists in preapproved + vendor master)
 */
async function ensureCompanyCounterInitialized() {
  if (initCompanyPromise) return initCompanyPromise;

  initCompanyPromise = (async () => {
    const regex = new RegExp(`^${COMPANY_PREFIX}\\d+$`);

    const [maxVendor, maxPre] = await Promise.all([
      vendorModel
        .findOne({ companyCode: regex })
        .sort({ companyCode: -1 })
        .select({ companyCode: 1 })
        .lean(),
      preapprovedVendorModel
        .findOne({ companyCode: regex })
        .sort({ companyCode: -1 })
        .select({ companyCode: 1 })
        .lean(),
    ]);

    const maxSeqVendor = maxVendor ? parseSeq(maxVendor.companyCode, COMPANY_PREFIX) : 0;
    const maxSeqPre = maxPre ? parseSeq(maxPre.companyCode, COMPANY_PREFIX) : 0;
    const maxSeq = Math.max(maxSeqVendor, maxSeqPre);

    await counterModel.findByIdAndUpdate(
      COMPANY_COUNTER_ID,
      { $max: { seq: maxSeq } },
      { upsert: true, new: true }
    );
  })();

  return initCompanyPromise;
}

async function nextCompanyCode() {
  await ensureCompanyCounterInitialized();

  const counter = await counterModel.findByIdAndUpdate(
    COMPANY_COUNTER_ID,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  const seq = counter?.seq || 1;
  return `${COMPANY_PREFIX}${pad(seq, COMPANY_PAD_LEN)}`;
}

/** =========================
 *  Routes
 *  ========================= */

// ✅ Create preapproved vendor (pending by default) + auto companyCode (CN00001...)
preapprovedVendorRouter.post("/", async (req, res, next) => {
  try {
    const payload = req.body || {};

    const name = String(payload.name || "").trim();
    if (!name) {
      return res.status(400).send({ success: false, message: "name is required" });
    }

    // ✅ always auto-generate companyCode if not provided
    // (recommended: do not trust client for sequential codes)
    let companyCode = String(payload.companyCode || "").trim();
    if (!companyCode) {
      companyCode = await nextCompanyCode();
    }

    // ✅ handle unique collision just like vendorCode (rare but safe)
    let created = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        created = await preapprovedVendorModel.create({
          ...payload,
          name,
          companyCode,
          status: "pending",
          contactPerson: Array.isArray(payload.contactPerson) ? payload.contactPerson : [],
        });
        break;
      } catch (e) {
        if (e?.code === 11000) {
          companyCode = await nextCompanyCode();
          continue;
        }
        throw e;
      }
    }

    if (!created) {
      return res.status(500).send({
        success: false,
        message: "Failed to create preapproved vendor with unique companyCode",
      });
    }

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
        { companyCode: { $regex: s, $options: "i" } },
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

    // OPTIONAL: block editing companyCode (recommended)
    if (payload.companyCode) delete payload.companyCode;

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

    const pre = await preapprovedVendorModel.findById(id);
    if (!pre) return res.status(404).send({ success: false, message: "Preapproved vendor not found" });

    if (pre.status === "approved") {
      return res.status(400).send({ success: false, message: "Already approved" });
    }

    // ✅ fallback: if somehow companyCode missing, generate now
    if (!String(pre.companyCode || "").trim()) {
      pre.companyCode = await nextCompanyCode();
      await pre.save();
    }

    const obj = pre.toObject();
    delete obj._id;
    delete obj.__v;
    delete obj.status;
    delete obj.createdAt;
    delete obj.updatedAt;

    let createdVendor = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const vendorCode = await nextVendorCode();
      try {
        createdVendor = await vendorModel.create({
          ...obj,
          vendorCode, // ✅ auto generated here
          companyCode: obj.companyCode, // ✅ keep same company code
        });
        break;
      } catch (e) {
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
