import { Schema, model } from "mongoose";

const indentTypeSchema = new Schema(
  {
    // e.g. "STANDARD", "SERVICE"
    code: { type: String, required: true, trim: true, uppercase: true },

    // e.g. "Standard", "Service"
    label: { type: String, required: true, trim: true },

    description: { type: String, default: "", trim: true },

    sortOrder: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false }
);

// ✅ ensure unique code
indentTypeSchema.index({ code: 1 }, { unique: true });

export default model("indent_type_master", indentTypeSchema);
