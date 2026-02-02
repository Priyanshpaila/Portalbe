import mongoose, { Schema, Types, model } from "mongoose"

const rfqSchema = new Schema(
	{
		rfqNumber: { type: String, required: true, unique: true },
		rfqDate: { type: Date },
		dueDate: { type: Date },
		dueDateRemarks: { type: String },
		createdBy: { type: Types.ObjectId, ref: "users" },
		submittedBy: { type: Types.ObjectId, ref: "users" },
		submittedAt: { type: Date },
		prevDueDates: [
			{
				dueDate: { type: Date },
				dueDateRemarks: { type: String }
			}
		],
		status: { type: Number, enum: [0, 1, 2], default: 0 },
		remarks: { type: String },
		contactPersonName: { type: String },
		contactNumber: { type: String },
		contactEmail: { type: String },
		termsConditions: { type: Map, of: String },
		attachments: [
			{
				file: { type: String },
				description: { type: String },
				size: { type: Number },
				status: { type: Number, default: 1 }
			}
		],
		items: [
			{
				itemId: { type: String },
				indentNumber: { type: String },
				itemCode: { type: String },
				itemDescription: { type: String },
				rfqMake: { type: String },
				rfqRemarks: { type: String },
				rfqTechSpec: { type: String },
				rfqQty: { type: Number },
				unit: { type: String },
				hsnCode: { type: String },
				techSpec: { type: String }
			}
		],
		vendors: [
			{
				status: { type: Number, enum: [0, 1, 2], default: 0 },
				vendorCode: { type: String },
				name: { type: String },
				contactPerson: {
					name: { type: String },
					email: { type: String }
				},
				location: { type: String },
				regretTimestamp: { type: Date }
			}
		]
	},
	{
		timestamps: { createdAt: true, updatedAt: true }
	}
)

export default mongoose.models.rfq || model("rfq", rfqSchema)
