import { Schema, model } from "mongoose"

export const ChargeSchema = new Schema(
	{
		type: { type: String },
		description: { type: String },
		amount: { type: Number },
		gstRate: { type: Number },
		gstAmount: { type: Number }
	},
	{ _id: false }
)

export const quotationSchema = new Schema(
	{
		validityDate: { type: Date },
		quotationNumber: { type: String, required: true, unique: true },
		quotationDate: { type: Date, required: true, default: Date.now },
		rfqNumber: { type: String, required: true },
		status: { type: Number, enum: [0, 1, 1.5, 2, 3], default: 0 },
		creditDays: { type: Number },
		freightType: { type: String },
		paymentMode: { type: String },
		remarks: { type: String },
		vendorCode: { type: String, required: true },
		vendorLocation: { type: String },
		companyCode: { type: String },
		termsConditions: { type: Map, of: String },
		contactPersonName: { type: String },
		contactNumber: { type: String },
		contactEmail: { type: String },
		attachments: [
			{
				file: { type: String },
				description: { type: String },
				size: { type: Number }
			}
		],
		amount: {
			basic: { type: Number },
			discount: { type: Number },
			otherCharges: { type: Number },
			igst: { type: Number },
			cgst: { type: Number },
			sgst: { type: Number },
			total: { type: Number }
		},
		charges: {
			otherCharges: ChargeSchema,
			packagingForwarding: ChargeSchema
		},
		items: [
			{
				itemId: { type: String },
				indentNumber: { type: String },
				itemCode: { type: String },
				qty: { type: Number },
				hsnCode: { type: String },
				make: { type: String },
				rate: { type: Number },

				discountType: { type: String, enum: ["percent", "amount"] },
				discountPercent: { type: Number },
				discountAmount: { type: Number },

				taxRate: { type: Number },
				delivery: { type: Number },
				remarks: { type: String },
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
		]
	},
	{
		timestamps: { createdAt: true, updatedAt: true }
	}
)

export default model("quotation", quotationSchema)
