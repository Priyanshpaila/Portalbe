import express from "express";
import bcrypt from "bcryptjs";

import userModel from "../models/user.model.js";
import preapprovedVendorModel from "../models/preapprovedVendor.model.js";
import counterModel from "../models/counter.model.js";
import roleModel from "../models/role.model.js";
import { PERMISSIONS } from "../lib/permissions.js";

import { sendMail } from "../lib/nodemailer.js"
import generateEmailBody from "../helpers/generateEmailBody.js"

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
  const s = String(num);
  const width = Math.max(len, s.length);
  return s.padStart(width, "0");
}

/** numeric-safe max sequence finder */
async function getMaxSeq(model, field, prefix) {
  const PREFIX_LEN = prefix.length;
  const regex = new RegExp(`^${prefix}\\d+$`);

  const result = await model.aggregate([
    { $match: { [field]: { $regex: regex } } },
    {
      $project: {
        seq: {
          $toInt: {
            $substrCP: [
              `$${field}`,
              PREFIX_LEN,
              { $subtract: [{ $strLenCP: `$${field}` }, PREFIX_LEN] },
            ],
          },
        },
      },
    },
    { $group: { _id: null, maxSeq: { $max: "$seq" } } },
  ]);

  return result?.[0]?.maxSeq || 0;
}

let initVendorPromise = null;
let initCompanyPromise = null;

async function ensureVendorCounterInitialized() {
  if (initVendorPromise) return initVendorPromise;

  initVendorPromise = (async () => {
    const maxSeq = await getMaxSeq(userModel, "vendorCode", VENDOR_PREFIX);
    await counterModel.findByIdAndUpdate(
      VENDOR_COUNTER_ID,
      { $setOnInsert: { _id: VENDOR_COUNTER_ID }, $max: { seq: maxSeq } },
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

async function ensureCompanyCounterInitialized() {
  if (initCompanyPromise) return initCompanyPromise;

  initCompanyPromise = (async () => {
    const [maxUser, maxPre] = await Promise.all([
      // NOTE: your user schema stores companyCode in vendorProfile.companyCode, not root
      getMaxSeq(userModel, "vendorProfile.companyCode", COMPANY_PREFIX).catch(
        () => 0
      ),
      getMaxSeq(preapprovedVendorModel, "companyCode", COMPANY_PREFIX),
    ]);

    const maxSeq = Math.max(maxUser || 0, maxPre || 0);

    await counterModel.findByIdAndUpdate(
      COMPANY_COUNTER_ID,
      { $setOnInsert: { _id: COMPANY_COUNTER_ID }, $max: { seq: maxSeq } },
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

/* ---------------- helpers ---------------- */

function normStr(v) {
  if (v == null) return "";
  return typeof v === "string" ? v.trim() : String(v);
}

function toLowerEmail(v) {
  const s = normStr(v);
  return s ? s.toLowerCase() : "";
}

/**
 * ✅ Map preapprovedVendor -> users.vendorProfile (matches your User schema exactly)
 */
function buildVendorProfileFromPreapproved(pre, vendorCode) {
  const contactPerson = Array.isArray(pre?.contactPerson)
    ? pre.contactPerson.map((cp) => ({
        // user schema: VendorContactPersonSchema (_id:false)
        name: normStr(cp?.name),
        email: toLowerEmail(cp?.email),
        mobilePhoneIndicator: normStr(cp?.mobilePhoneIndicator), // might not exist -> ""
        fullPhoneNumber: normStr(cp?.fullPhoneNumber),
        callerPhoneNumber: normStr(cp?.callerPhoneNumber), // might not exist -> ""
      }))
    : [];

  const companyCode = normStr(pre?.companyCode);

  return {
    vendorCode, // keep in sync; your pre("validate") also does this
    companyCode,

    // these are the fields you showed in preapproved doc
    name: normStr(pre?.name),
    city: normStr(pre?.city),
    district: normStr(pre?.district),
    postalCode: normStr(pre?.postalCode),
    panNumber: normStr(pre?.panNumber),
    msme: normStr(pre?.msme),
    gstin: normStr(pre?.gstin),
    street: normStr(pre?.street),
    languageKey: normStr(pre?.languageKey),
    region: normStr(pre?.region),

    // optional “orgName1/orgName2” in your schema
    orgName1: normStr(pre?.name), // sensible default
    orgName2: "",

    // keep other vendorProfile fields as empty strings (schema defaults cover it)
    countryKey: normStr(pre?.countryKey),
    name1: "",
    name2: "",
    name3: "",
    name4: "",
    poBox: normStr(pre?.poBox),
    poBoxPostalCode: normStr(pre?.poBoxPostalCode),
    creationDate: normStr(pre?.creationDate),
    sortField: normStr(pre?.sortField),
    streetHouseNumber: normStr(pre?.streetHouseNumber),
    cityPostalCode: normStr(pre?.cityPostalCode),
    street2: normStr(pre?.street2),
    street3: normStr(pre?.street3),
    street4: normStr(pre?.street4),
    street5: normStr(pre?.street5),

    contactPerson,
  };
}

/* =========================
 * Routes
 * ========================= */

// Create preapproved vendor (pending) + auto companyCode
preapprovedVendorRouter.post("/", async (req, res, next) => {
  try {
    const payload = req.body || {};

    const name = normStr(payload.name);
    if (!name) {
      return res
        .status(400)
        .send({ success: false, message: "name is required" });
    }

    let companyCode = normStr(payload.companyCode);
    if (!companyCode) {
      companyCode = await nextCompanyCode();
    }

    let created = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        created = await preapprovedVendorModel.create({
          ...payload,
          name,
          companyCode,
          status: "pending",
          contactPerson: Array.isArray(payload.contactPerson)
            ? payload.contactPerson
            : [],
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

// List preapproved vendors
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

    const data = await preapprovedVendorModel
      .find(match)
      .sort({ createdAt: -1 });

    res.status(200).send({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Update preapproved vendor (only if pending)
preapprovedVendorRouter.put("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const payload = req.body || {};

    if (payload.status) delete payload.status;
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

// ✅ Approve: create vendor USER correctly (map -> vendorProfile) + send credentials email
preapprovedVendorRouter.post("/:id/approve", async (req, res, next) => {
  try {
    const id = req.params.id;

    const pre = await preapprovedVendorModel.findById(id);
    if (!pre) {
      return res
        .status(404)
        .send({ success: false, message: "Preapproved vendor not found" });
    }

    if (pre.status === "approved") {
      return res
        .status(400)
        .send({ success: false, message: "Already approved" });
    }

    const vendorRole = await roleModel.findOne(
      { permissions: { $in: [PERMISSIONS.VENDOR_ACCESS] }, status: 1 },
      { _id: 1 }
    );

    if (!vendorRole?._id) {
      return res.status(500).send({
        success: false,
        message: `Vendor role not found. Create a role having permission "${PERMISSIONS.VENDOR_ACCESS}".`,
      });
    }

    if (!normStr(pre.companyCode)) {
      pre.companyCode = await nextCompanyCode();
      await pre.save();
    }

    const contactEmail =
      Array.isArray(pre.contactPerson) && pre.contactPerson.length > 0
        ? toLowerEmail(pre.contactPerson[0]?.email)
        : "";

    let createdVendorUser = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const vendorCode = await nextVendorCode();

      try {
        const username = vendorCode;
        const passwordHash = await bcrypt.hash(vendorCode, 10);

        const vendorProfile = buildVendorProfileFromPreapproved(pre, vendorCode);

        createdVendorUser = await userModel.create({
          vendorCode,
          firmId: null,

          role: vendorRole._id,

          username,
          password: passwordHash,
          passwordStatus: "temporary",

          name: normStr(pre.name) || vendorCode,
          email: contactEmail || "",

          vendorProfile,

          createdBy: req?.user?._id || req?.user?.id || null,
          status: 1,
        });

        break;
      } catch (e) {
        if (e?.code === 11000) continue;
        throw e;
      }
    }

    if (!createdVendorUser) {
      return res.status(500).send({
        success: false,
        message: "Failed to create vendor user with unique vendorCode/username",
      });
    }

    pre.status = "approved";
    await pre.save();

    let emailSent = false;
    let emailError = null;

    if (contactEmail) {
      try {
        await sendMail({
          to: contactEmail,
          subject: "Vendor Portal Login Credentials",
          text: generateEmailBody.vendorCredentials(
            createdVendorUser.username,
            createdVendorUser._id
          ),
        });

        emailSent = true;
      } catch (mailErr) {
        emailError = mailErr?.message || "Failed to send credentials email";
        console.error("Vendor credentials email failed:", mailErr);
      }
    } else {
      emailError = "Vendor contact email not found";
    }

    return res.status(200).send({
      success: true,
      message: emailSent
        ? "Vendor approved, created in users collection, and credentials email sent"
        : "Vendor approved and created in users collection, but credentials email was not sent",
      vendorUser: createdVendorUser,
      emailSent,
      emailError,
      credentials: {
        username: createdVendorUser.username,
        password: createdVendorUser.vendorCode,
        vendorCode: createdVendorUser.vendorCode,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default preapprovedVendorRouter;