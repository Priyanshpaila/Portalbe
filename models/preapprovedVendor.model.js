import { Schema, model } from "mongoose";

const preapprovedVendorSchema = new Schema(
  {
    // ✅ status added
    status: {
      type: String,
      enum: ["pending", "approved"],
      default: "pending",
      index: true,
    },

    // ✅ SAME FIELDS as vendor but WITHOUT vendorCode
    countryKey: { type: String },
    name: { type: String },
    name1: { type: String },
    name2: { type: String },
    name3: { type: String },
    name4: { type: String },
    city: { type: String },
    district: { type: String },
    poBox: { type: String },
    poBoxPostalCode: { type: String },
    postalCode: { type: String },
    creationDate: { type: String },
    sortField: { type: String },
    streetHouseNumber: { type: String },
    panNumber: { type: String },
    msme: { type: String },
    gstin: { type: String },
    orgName1: { type: String },
    orgName2: { type: String },
    companyCode: { type: String, unique: true, index: true },
    cityPostalCode: { type: String },
    street: { type: String },
    street2: { type: String },
    street3: { type: String },
    street4: { type: String },
    street5: { type: String },
    languageKey: { type: String },
    region: { type: String },
    contactPerson: [
      {
        name: { type: String },
        email: { type: String },
        mobilePhoneIndicator: { type: String },
        fullPhoneNumber: { type: String },
        callerPhoneNumber: { type: String },
      },
    ],
  },
  { timestamps: true }
);

// ✅ model name exactly as you asked:
export default model("preapprovedvendors", preapprovedVendorSchema);
