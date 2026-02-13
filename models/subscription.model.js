import mongoose from "mongoose";

const { Schema } = mongoose;

const SubscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "users", required: true, index: true },

    plan: { type: String, default: "monthly" },

    // lifecycle
    status: {
      type: String,
      enum: ["pending", "active", "expired", "cancelled", "failed"],
      default: "pending",
      index: true,
    },

    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },

    // Razorpay details
    orderId: { type: String, index: true },     // rzp_order_xxx
    paymentId: { type: String, default: null }, // rzp_payment_xxx
    signature: { type: String, default: null },

    amount: { type: Number, required: true },   // in paise
    currency: { type: String, default: "INR" },

    notes: { type: Object, default: {} },
  },
  { timestamps: true }
);

SubscriptionSchema.index({ userId: 1, status: 1, endAt: -1 });

export default mongoose.model("subscriptions", SubscriptionSchema);