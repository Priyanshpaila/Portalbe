import mongoose, { Schema, Types, model } from "mongoose"

const rfqSchema = new Schema(
	{
		rfqNumber: { type: String, required: true },
		quotationNumber: { type: String, required: true },
		vendorCode: { type: String, required: true },
		vendorLocation: { type: String },
		savedAt: { type: Date },
		savedBy: { type: Types.ObjectId, ref: "users" },
		submittedAt: { type: Date },
		submittedBy: { type: Types.ObjectId, ref: "users" },
		status: { type: Number, enum: [0, 1], default: 0 },
		items: [
			{
				indentNumber: { type: String },
				itemCode: { type: String },
				negotiationOn: [{ type: String }],
				rate: { type: Number },
				discountAmount: { type: Number },
				discountPercent: { type: Number },
				basicAfterDiscount: { type: Number },
				make: { type: String },
				savings: { type: Number }
			}
		],
		charges: {
			otherCharges: { type: Number },
			packagingForwarding: { type: Number }
		},
		termsConditions: { type: Map, of: String },
		savings: {
			items: { type: Number },
			charges: { type: Number },
			total: { type: Number }
		}
	},
	{
		timestamps: { createdAt: true, updatedAt: false }
	}
)

export default mongoose.models.negotiation || model("negotiation", rfqSchema)
