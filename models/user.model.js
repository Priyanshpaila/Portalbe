import mongoose from "mongoose";

const { Schema, Types, model } = mongoose;

/* ---------------- Vendor sub-schema (same fields as your vendor model) ---------------- */

const VendorContactPersonSchema = new Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    mobilePhoneIndicator: { type: String, default: "" },
    fullPhoneNumber: { type: String, default: "" },
    callerPhoneNumber: { type: String, default: "" },
  },
  { _id: false },
);

const VendorProfileSchema = new Schema(
  {
    // keep vendorCode also inside profile for completeness (root vendorCode is still the source of truth)
    vendorCode: { type: String, default: null },

    countryKey: { type: String, default: "" },
    name: { type: String, default: "" },

    name1: { type: String, default: "" },
    name2: { type: String, default: "" },
    name3: { type: String, default: "" },
    name4: { type: String, default: "" },

    city: { type: String, default: "" },
    district: { type: String, default: "" },

    poBox: { type: String, default: "" },
    poBoxPostalCode: { type: String, default: "" },
    postalCode: { type: String, default: "" },

    creationDate: { type: String, default: "" },
    sortField: { type: String, default: "" },

    streetHouseNumber: { type: String, default: "" },

    panNumber: { type: String, default: "" },
    msme: { type: String, default: "" },
    gstin: { type: String, default: "" },

    orgName1: { type: String, default: "" },
    orgName2: { type: String, default: "" },

    companyCode: { type: String, default: "" },

    cityPostalCode: { type: String, default: "" },

    street: { type: String, default: "" },
    street2: { type: String, default: "" },
    street3: { type: String, default: "" },
    street4: { type: String, default: "" },
    street5: { type: String, default: "" },

    languageKey: { type: String, default: "" },
    region: { type: String, default: "" },

    contactPerson: { type: [VendorContactPersonSchema], default: [] },
  },
  { _id: false },
);

/* ---------------- Main users schema (firm + vendor in same collection) ---------------- */

const userSchema = new Schema(
  {
    /**
     * ✅ If vendorCode exists => VENDOR account
     * ✅ If vendorCode does NOT exist => FIRM root or firm employee (depends on firmId)
     */
    vendorCode: { type: String, trim: true, default: null, index: true },

    /**
     * ✅ Seat-based firm users:
     * - firm root: firmId = null AND vendorCode = null
     * - firm employee: firmId = <firm root user _id> AND vendorCode = null
     */
    firmId: { type: Types.ObjectId, ref: "users", default: null, index: true },

    digitalSignature: { type: String, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },

    username: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },

    passwordStatus: {
      type: String,
      enum: ["temporary", "permanent"],
      required: true,
      default: "temporary",
    },

    createdBy: { type: Types.ObjectId, ref: "users", default: null },

    /**
     * ✅ Keep your existing display name (required)
     * - For vendors you can set this = vendorProfile.name OR name1/orgName1 etc.
     */
    name: { type: String, required: true, trim: true },

    role: { type: Types.ObjectId, ref: "role", default: null },

    /**
     * ✅ Firm company details
     * - required ONLY for firm ROOT users (not vendor, not firm employee)
     */
    company: {
      name: {
        type: String,
        trim: true,
        default: "",
        required: function () {
          const isVendor = !!(
            this.vendorCode && String(this.vendorCode).trim()
          );
          const isFirmEmployee = !!this.firmId;
          return !isVendor && !isFirmEmployee;
        },
      },

      industry: { type: String, trim: true, default: "", index: true },

      gstin: { type: String, trim: true, uppercase: true, default: "" },
      pan: { type: String, trim: true, uppercase: true, default: "" },

      phone: { type: String, trim: true, default: "" },
      website: { type: String, trim: true, default: "" },

      addressLine1: { type: String, trim: true, default: "" },
      addressLine2: { type: String, trim: true, default: "" },
      city: { type: String, trim: true, default: "" },
      state: { type: String, trim: true, default: "" },
      pincode: { type: String, trim: true, default: "" },
    },

    /**
     * ✅ Vendor fields (all fields from vendor schema)
     * - Only meaningful when vendorCode is present
     */
    vendorProfile: { type: VendorProfileSchema, default: {} },

    /**
     * ✅ Friend-like vendor<->firm association (your existing structure)
     */
    firmVendorLinks: [
      {
        vendorUserId: { type: Types.ObjectId, ref: "users", required: true },
        status: {
          type: String,
          enum: ["pending", "active", "blocked", "removed"],
          default: "pending",
          index: true,
        },
        activeUntil: { type: Date, default: null },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    vendorFirmLinks: [
      {
        firmUserId: { type: Types.ObjectId, ref: "users", required: true },
        status: {
          type: String,
          enum: ["pending", "active", "blocked", "removed"],
          default: "pending",
          index: true,
        },
        activeUntil: { type: Date, default: null },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    status: { type: Number, enum: [0, 1], default: 1, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    minimize: false,
  },
);

/* ---------------- Indexes ---------------- */

// ✅ vendorCode must be unique ONLY when it is a real string (prevents "null duplicates" breaking)
userSchema.index(
  { vendorCode: 1 },
  {
    unique: true,
    partialFilterExpression: { vendorCode: { $type: "string", $ne: "" } },
  },
);

userSchema.index({ firmId: 1 }, { sparse: true });

// firm filtering
userSchema.index({ "company.industry": 1 }, { sparse: true });
userSchema.index({ "company.name": 1 }, { sparse: true });

// vendor filtering / searches
userSchema.index({ "vendorProfile.gstin": 1 }, { sparse: true });
userSchema.index({ "vendorProfile.panNumber": 1 }, { sparse: true });
userSchema.index({ "vendorProfile.companyCode": 1 }, { sparse: true });

// unique GSTIN for firms only (safe)
userSchema.index(
  { "company.gstin": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "company.gstin": { $type: "string", $ne: "" },
      vendorCode: { $in: [null, ""] },
      firmId: { $eq: null },
    },
  },
);

/* ---------------- Guards / Normalizers ---------------- */

function normStr(v) {
  if (v == null) return "";
  return typeof v === "string" ? v.trim() : String(v);
}

userSchema.pre("validate", function (next) {
  try {
    // normalize vendorCode -> null if empty
    if (typeof this.vendorCode === "string") {
      const v = this.vendorCode.trim();
      this.vendorCode = v ? v : null;
    }

    // ensure company exists
    if (!this.company) this.company = {};

    // normalize company strings
    const companyFields = [
      "name",
      "industry",
      "gstin",
      "pan",
      "phone",
      "website",
      "addressLine1",
      "addressLine2",
      "city",
      "state",
      "pincode",
    ];
    for (const k of companyFields) {
      if (this.company[k] == null) this.company[k] = "";
      if (typeof this.company[k] === "string")
        this.company[k] = this.company[k].trim();
    }

    // ensure vendorProfile exists
    if (!this.vendorProfile) this.vendorProfile = {};

    // if vendor account, keep vendorProfile.vendorCode in sync
    if (this.vendorCode) {
      this.vendorProfile.vendorCode = this.vendorCode;
    } else {
      // firm account -> keep vendorProfile.vendorCode null (but keep object for safety)
      this.vendorProfile.vendorCode = null;
    }

    // normalize vendorProfile string fields (same keys as vendor schema)
    const vp = this.vendorProfile || {};
    const vendorFields = [
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
    ];

    for (const k of vendorFields) {
      if (vp[k] == null) vp[k] = "";
      vp[k] = normStr(vp[k]);
    }

    // normalize contactPerson array
    if (!Array.isArray(vp.contactPerson)) vp.contactPerson = [];
    vp.contactPerson = vp.contactPerson.map((cp) => ({
      name: normStr(cp?.name),
      email: normStr(cp?.email),
      mobilePhoneIndicator: normStr(cp?.mobilePhoneIndicator),
      fullPhoneNumber: normStr(cp?.fullPhoneNumber),
      callerPhoneNumber: normStr(cp?.callerPhoneNumber),
    }));

    // write back
    this.vendorProfile = vp;

    next();
  } catch (e) {
    next(e);
  }
});

/**
 * IMPORTANT:
 * Your refs already use ref: "users" (subscription middleware etc.)
 * So keep model name "users" to match populate/ref usage.
 */
export default model("users", userSchema);
