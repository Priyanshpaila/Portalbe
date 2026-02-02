import { Schema, model, Types } from "mongoose"
import { ChargeSchema } from "./quotation.model.js"

const taxDetailSchema = [
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
]

const poSchema = new Schema(
	{
		poNumber: { type: String },
		poDate: { type: Date },
		sapPONumber: { type: String },
		amendNumber: { type: Number },
		amendRemarks: { type: String },
		amendHistory: [
			{
				amendedBy: { type: Types.ObjectId, ref: "users" },
				amendedAt: { type: Date }
			}
		],
		company: { type: String },
		division: { type: String },
		purchaseType: { type: String },
		refDocumentType: { type: String },
		refDocumentNumber: { type: String },
		refCSNumber: { type: String },
		refCSDate: { type: Date },
		vendorCode: { type: String },
		vendorName: { type: String },
		vendorLocation: { type: String },
		contactPersonName: { type: String },
		serialNumber: { type: String },
		validityDate: { type: Date },
		departmentName: { type: String },
		remarks: { type: String },

		items: [
			{
				itemId: { type: String },
				indentNumber: { type: String },
				itemCode: { type: String },
				itemDescription: { type: String },
				hsnCode: { type: String },
				make: { type: String },
				techSpec: { type: String },
				qty: { type: Number },
				schedule: { type: String },
				unit: { type: String },
				tolerance: {
					basis: { type: String },
					positive: { type: Number },
					negative: { type: Number }
				},
				csNumber: { type: String },
				csDate: { type: Date },

				remarks: { type: String },
				rate: { type: Number },
				taxDetails: taxDetailSchema,
				amount: {
					basic: { type: Number },
					taxable: { type: Number },
					igst: { type: Number },
					cgst: { type: Number },
					sgst: { type: Number },
					total: { type: Number }
				}
			}
		],

		shippingAccount: {
			paymentMode: { type: String },
			freightType: { type: String },
			freightRate: { type: String },
			freightAmount: { type: String },
			priority: { type: String },
			fromLocation: { type: String },
			toLocation: { type: String },
			shippingAddress: { type: String },
			defineTransportationRoute: { type: String }
		},

		amount: {
			basic: { type: Number },
			discount: { type: Number },
			totalTax: { type: Number },
			otherCharges: { type: Number },
			igst: { type: Number },
			cgst: { type: Number },
			sgst: { type: Number },
			total: { type: Number }
		},
		termsConditions: { type: Map, of: String },
		paymentTerms: [
			{
				paymentType: { type: String },
				baseDateType: { type: String },
				payOn: { type: String },
				payValuePercent: { type: Number },
				payValueAmount: { type: Number },
				days: { type: Number },
				remarks: { type: String }
			}
		],
		readyForAuthorization: { type: Boolean, default: false },
		rejectionComment: { type: String },
		authorize: [
			{
				user: { type: Types.ObjectId, ref: "users" },
				assignOn: { type: Date, default: Date.now },
				changedOn: { type: Date },
				approvalStatus: { type: Number, enum: [0, 1, 2], default: 0 },
				comment: { type: String }
			}
		],
		attachments: [
			{
				file: { type: String },
				description: { type: String },
				size: { type: Number },
				status: { type: Number, default: 1 }
			}
		],
		taxDetails: taxDetailSchema,
		charges: {
			otherCharges: ChargeSchema,
			packagingForwarding: ChargeSchema
		}
	},
	{
		timestamps: { createdAt: true, updatedAt: false }
	}
)

export default model("purchase_order", poSchema)
