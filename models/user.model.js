import { Schema, Types, model } from "mongoose"

const userSchema = new Schema(
	{
		vendorCode: {
			type: String
		},
		digitalSignature: {
			type: String
		},
		email: {
			type: String
		},
		username: {
			type: String,
			required: true,
			unique: true
		},
		password: {
			type: String,
			required: true
		},
		passwordStatus: {
			type: String,
			enum: ["temporary", "permanent"],
			required: true,
			default: "temporary"
		},
		createdBy: {
			type: Types.ObjectId,
			ref: "users"
		},
		name: {
			type: String,
			required: true
		},
		role: {
			type: Types.ObjectId,
			ref: "roles"
		},
		status: {
			type: Number,
			enum: [0, 1],
			default: 1,
			required: true
		}
	},
	{
		timestamps: { createdAt: true, updatedAt: false }
	}
)

export default model("user", userSchema)
