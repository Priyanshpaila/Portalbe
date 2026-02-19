import mongoose from "mongoose";

const { Schema } = mongoose;

const SubscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "users", required: true, index: true },

    plan: { type: String, default: "monthly" },

    // capacity purchased (Netflix-style)
    seats: { type: Number, default: 1, min: 1 },
    firmLimit: { type: Number, default: 1, min: 1 },

    status: {
      type: String,
      enum: ["pending", "active", "expired", "cancelled", "failed"],
      default: "pending",
      index: true,
    },

    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },

    // ✅ Razorpay order id
    orderId: { type: String, default: null }, // keep as field (index via schema.index below)

    paymentId: { type: String, default: null },
    signature: { type: String, default: null },

    amount: { type: Number, required: true }, // paise
    currency: { type: String, default: "INR" },

    notes: { type: Object, default: {} },
  },
  { timestamps: true }
);

// ✅ common query patterns
SubscriptionSchema.index({ userId: 1, status: 1, endAt: -1 });
SubscriptionSchema.index({ userId: 1, createdAt: -1 });

// ✅ IMPORTANT: avoid duplicate subscriptions for same Razorpay order
// sparse => allows many docs where orderId is null
SubscriptionSchema.index({ orderId: 1 }, { unique: true, sparse: true });

// ✅ optional but useful for debugging/support
SubscriptionSchema.index({ paymentId: 1 }, { sparse: true });

export default mongoose.model("subscriptions", SubscriptionSchema);