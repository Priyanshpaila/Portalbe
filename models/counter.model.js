import { Schema, model } from "mongoose";

const counterSchema = new Schema(
  {
    _id: { type: String, required: true }, // e.g. "vendorCode"
    seq: { type: Number, default: 0 },
  },
  { versionKey: false, timestamps: true }
);

export default model("counter", counterSchema);
