import mongoose from "mongoose";

const paymentOrderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "users", index: true, required: true },
    planId: { type: String, required: true },

    receipt: { type: String, required: true, index: true },
    razorpayOrderId: { type: String, required: true, unique: true, index: true },

    amount: { type: Number, required: true },   // paise
    currency: { type: String, required: true }, // INR

    status: { type: String, enum: ["created", "paid", "failed"], default: "created", index: true },

    razorpayPaymentId: { type: String, default: "" },
    razorpaySignature: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("payment_orders", paymentOrderSchema);