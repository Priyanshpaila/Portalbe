import { Schema, Types, model } from "mongoose"
import { PERMISSIONS } from "../lib/permissions.js"

const roleSchema = new Schema(
	{
		name: {
			type: String,
			required: true,
			unique: true
		},
		createdBy: {
			type: Types.ObjectId,
			ref: "users"
		},
		status: {
			type: Number,
			enum: [0, 1],
			default: 1,
			required: true
		},
		permissions: [
			{
				type: String
			}
		],
		hidden: { type: Boolean, default: false }
	},
	{
		timestamps: { createdAt: true, updatedAt: false }
	}
)

export default model("role", roleSchema)
