import mongoose from "mongoose";

const { Schema } = mongoose;

const paymentOrderSchema = new Schema(
  {
    // ✅ "Who is paying" (subscription owner)
    billingOwnerId: {
      type: Schema.Types.ObjectId,
      ref: "users",
      index: true,
      default: null,
    },

    // ✅ "Who initiated" the purchase (employee/admin)
    createdByUserId: {
      type: Schema.Types.ObjectId,
      ref: "users",
      index: true,
      default: null,
    },

    // ✅ Keep your original field (compat)
    userId: {
      type: Schema.Types.ObjectId,
      ref: "users",
      index: true,
      required: true,
    },

    // ✅ what this order is for
    kind: {
      type: String,
      enum: ["subscription_new", "upgrade_seats", "upgrade_connections"],
      default: "subscription_new",
      index: true,
    },

    // ✅ subscription targeted (for upgrades) OR created subscription (for audit)
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: "subscriptions",
      default: null,
      index: true,
    },

    // planId: "monthly" | "yearly" | "monthly_tier_5" ...
    planId: { type: String, required: true, index: true },

    // ---- knobs ----
    // NOTE:
    //  - subscription_new: seats = TOTAL seats, firmCount = TOTAL connections
    //  - upgrades: seats = DELTA seats, firmCount = DELTA connections
    // ✅ PERFECT: allow 0 so vendor connection upgrades don't need fake seats=1
    seats: { type: Number, default: 0, min: 0 },
    firmCount: { type: Number, default: 0, min: 0 },
    vendorLinkCount: { type: Number, default: 0, min: 0 },

    // optional targets (UI/audit)
    targetSeats: { type: Number, default: 0, min: 0 },
    targetFirmCount: { type: Number, default: 0, min: 0 },

    // ---- pricing breakdown ----
    baseAmount: { type: Number, default: 0 }, // paise
    addonsAmount: { type: Number, default: 0 }, // paise

    amount: { type: Number, required: true }, // paise
    currency: { type: String, required: true, default: "INR" },

    receipt: { type: String, required: true, index: true, maxlength: 40 },
    razorpayOrderId: { type: String, required: true, unique: true, index: true },

    status: {
      type: String,
      enum: ["created", "paid", "failed"],
      default: "created",
      index: true,
    },

    razorpayPaymentId: { type: String, default: "" },
    razorpaySignature: { type: String, default: "" },

    // ✅ PERFECT: upgrade idempotency flag (prevents double apply even under race)
    applied: { type: Boolean, default: false, index: true },
    appliedAt: { type: Date, default: null },

    clientRequestId: { type: String, default: "", index: true },
    notes: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

paymentOrderSchema.index({ billingOwnerId: 1, status: 1, createdAt: -1 });
paymentOrderSchema.index({ userId: 1, status: 1, createdAt: -1 });
paymentOrderSchema.index({ planId: 1, status: 1, createdAt: -1 });
paymentOrderSchema.index({ kind: 1, status: 1, createdAt: -1 });
paymentOrderSchema.index({ subscriptionId: 1, status: 1, createdAt: -1 });
paymentOrderSchema.index({ kind: 1, billingOwnerId: 1, applied: 1, createdAt: -1 });

// ✅ PERFECT: dedupe per kind (so same clientRequestId can exist across different actions)
paymentOrderSchema.index(
  { billingOwnerId: 1, kind: 1, clientRequestId: 1 },
  { unique: true, sparse: true }
);

export default mongoose.model("payment_orders", paymentOrderSchema);