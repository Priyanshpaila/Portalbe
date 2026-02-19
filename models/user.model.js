
import { Schema, Types, model } from "mongoose";

const userSchema = new Schema(
  {
    /**
     * ✅ If vendorCode exists => this user is a VENDOR account.
     * ✅ If vendorCode does NOT exist => this user is a FIRM account OR a firm-employee (depends on firmId)
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

    name: { type: String, required: true, trim: true },

    role: { type: Types.ObjectId, ref: "roles", default: null },

    /**
     * ✅ Firm company details
     * - required ONLY for firm ROOT users (not vendor, not firm employee)
     * - safe defaults so missing frontend fields won't crash
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
          // ✅ Require company.name only for firm ROOT account
          return !isVendor && !isFirmEmployee;
        },
      },

      // ✅ Make ONE field filterable on frontend (industry)
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
     * ✅ “Friends-like” vendor <-> firm association
     * - We keep it inside user so you can filter vendors visible to firm, etc.
     * - Keeps your existing vendorModel unchanged.
     *
     * firmVendorLinks: only meaningful for firm users (vendorCode empty)
     * vendorFirmLinks: only meaningful for vendor users (vendorCode present)
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
        // ✅ tie link validity to subscription
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
    minimize: false, // ✅ keep empty objects; safer for company defaults
  },
);

/** =========================
 * ✅ Indexes (safe + non-crashing)
 * ========================= */

// common queries
userSchema.index({ vendorCode: 1 }, { sparse: true });
userSchema.index({ firmId: 1 }, { sparse: true });

// filtering firms by industry/name
userSchema.index({ "company.industry": 1 }, { sparse: true });
userSchema.index({ "company.name": 1 }, { sparse: true });

// unique GSTIN for firms only (optional, safe)
userSchema.index(
  { "company.gstin": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "company.gstin": { $type: "string" },
      vendorCode: { $in: [null, ""] },
      firmId: { $eq: null },
    },
  },
);

/** =========================
 * ✅ Guards (prevent bad data from crashing)
 * ========================= */
userSchema.pre("validate", function (next) {
  try {
    // normalize vendorCode
    if (typeof this.vendorCode === "string") {
      const v = this.vendorCode.trim();
      this.vendorCode = v ? v : null;
    }

    // ensure company exists
    if (!this.company) this.company = {};

    // normalize company strings so undefined doesn't break UI
    const fields = [
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
    for (const k of fields) {
      if (this.company[k] == null) this.company[k] = "";
      if (typeof this.company[k] === "string")
        this.company[k] = this.company[k].trim();
    }

    next();
  } catch (e) {
    next(e);
  }
});

export default model("user", userSchema);
