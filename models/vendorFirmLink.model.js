import mongoose from "mongoose";

const { Schema } = mongoose;

const VendorFirmLinkSchema = new Schema(
  {
    // Firm side (your normal users)
    firmId: { type: Schema.Types.ObjectId, ref: "users", required: true, index: true },

    // Vendor side (your vendor entity is identified by vendorCode)
    vendorCode: { type: String, required: true, index: true },

    // request lifecycle (like friend request)
    status: {
      type: String,
      enum: ["pending", "active", "rejected", "cancelled", "expired"],
      default: "pending",
      index: true,
    },

    requestedBy: { type: String, enum: ["firm", "vendor"], required: true },

    requestedByUserId: { type: Schema.Types.ObjectId, ref: "users", required: true },
    approvedByUserId: { type: Schema.Types.ObjectId, ref: "users", default: null },

    // tie validity (IMPORTANT: we will set endAt = vendor subscription endAt)
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },

    // vendor subscription that allowed this tie
    subscriptionId: { type: Schema.Types.ObjectId, ref: "subscriptions", default: null },

    message: { type: String, default: "" },
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

// fast lookups
VendorFirmLinkSchema.index({ firmId: 1, vendorCode: 1, status: 1 });
VendorFirmLinkSchema.index({ vendorCode: 1, status: 1, endAt: -1 });

export default mongoose.model("vendor_firm_links", VendorFirmLinkSchema);