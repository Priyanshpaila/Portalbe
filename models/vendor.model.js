import { Schema, model } from "mongoose";

const vendorSchema = new Schema({
  vendorCode: { type: String, unique: true, index: true },
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
  companyCode: { type: String },
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
});

export default model("vendor", vendorSchema);
