import { Schema, model } from "mongoose";

const indentSchema = new Schema({
  id: { type: String, unique: true },
  indentNumber: { type: String },
  itemCode: { type: String },
  itemDescription: { type: String },

  company: { type: String },
  costCenter: { type: String },
  remark: { type: String },
  make: { type: String },
  techSpec: { type: String },
  unitOfMeasure: { type: String },

  documentNumber: { type: String },
  documentDate: { type: Date },
  documentType: { type: String },

  lineNumber: { type: String },

  createdBy: { type: String },
  requestedBy: { type: String },

  createdOn: { type: Date },
  lastChangedOn: { type: Date },

  indentQty: { type: Number },
  preRFQQty: { type: Number, default: 0 },
  prePOQty: { type: Number, default: 0 },
  balanceQty: { type: Number, default: 0 },

  deletionIndicator: { type: String },
  creationIndicator: { type: String },
  controlIndicator: { type: String },
  documentCategory: { type: String },
  materialNumber: { type: String },
  storageLocation: { type: String },
  trackingNumber: { type: String },
  orderItemNumber: { type: String },
  packageNumber: { type: String },
  utcTimestamp: { type: Date },
});

indentSchema.index({ documentCategory: 1, itemCode: 1 }, { unique: true });

export default model("indent", indentSchema);
