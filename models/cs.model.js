import { Schema, Types, model } from "mongoose"
import { ChargeSchema } from "./quotation.model.js"

const csModel = new Schema(
	{
		csNumber: { type: String, unique: true },
		csDate: { type: Date },
		csValidity: { type: Date },
		csRemarks: { type: String },
		csType: { type: String, enum: ["item_wise", "over_all"] },
		rfqNumber: { type: String },
		rfqDate: { type: Date },
		authorizedBy: { type: Types.ObjectId, ref: "users" },
		authorizedAt: { type: Date },
		status: { type: Number, default: 0, enum: [0, 1, 2] },

		vendors: [
			{
				name: { type: String },
				vendorCode: { type: String },
				companyCode: { type: String },
				vendorLocation: { type: String },
				quotationNumber: { type: String },
				quotationDate: { type: Date },
				contactPersonName: { type: String },
				contactNumber: { type: String },
				contactEmail: { type: String },
				termsConditions: { type: Map },
				remarks: { type: String },
				freightType: { type: String },
				charges: {
					otherCharges: ChargeSchema,
					packagingForwarding: ChargeSchema
				},
				total: {
					basicAfterDiscount: { type: Number },
					gst: { type: Number },
					netAmount: { type: Number }
				}
			}
		],
		items: [
			{
				indentNumber: { type: String },
				itemCode: { type: String },
				itemDescription: { type: String },
				qty: { type: Number },
				unit: { type: String },
				poStatus: { type: Number, enum: [0, 1], default: 0 },
				vendors: [
					{
						vendorCode: { type: String },
						poQty: { type: Number, default: 0 },
						lastPoRate: { type: String },
						lastPoNo: { type: String },
						lastPoDate: { type: Date },
						lastPoVendor: { type: String },

						make: { type: String },
						rate: { type: Number },

						basicAmount: { type: Number },
						discount: { type: Number },

						basicAfterDiscount: { type: Number },
						rateAfterDiscount: { type: Number },

						taxRate: { type: Number },
						taxDetails: [
							{
								chargeName: { type: String },
								chargeType: { type: String },
								nature: { type: String },
								chargeOn: { type: String },
								chargeValue: { type: Number },
								chargeAmount: { type: Number },
								taxField: { type: String, enum: ["igst", "cgst", "sgst", "utgst"] },
								status: { type: Number, enum: [0, 1], default: 0 }
							}
						],
						amount: {
							basic: { type: Number },
							taxable: { type: Number },
							igst: { type: Number },
							cgst: { type: Number },
							sgst: { type: Number },
							utgst: { type: Number },
							total: { type: Number }
						}
					}
				],
				leastValues: {
					basicAfterDiscount: {
						value: { type: Number },
						vendorCode: { type: Number }
					},
					rateAfterDiscount: {
						value: { type: Number },
						vendorCode: { type: Number }
					}
				}
			}
		],
		selection: [
			{
				indentNumber: { type: String },
				itemCode: { type: String },
				vendorCode: { type: String },
				quotationNumber: { type: String },
				quotationDate: { type: Date },
				qty: { type: Number }
			}
		],
		leastValues: {
			basicAfterDiscount: {
				value: { type: Number },
				vendorCode: { type: Number }
			},
			netAmount: {
				value: { type: Number },
				vendorCode: { type: Number }
			}
		}
	},
	{
		timestamps: { createdAt: true, updatedAt: true }
	}
)

export default model("comparative_statement", csModel)
