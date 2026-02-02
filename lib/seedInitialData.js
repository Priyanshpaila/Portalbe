import { Types } from "mongoose"
import User from "../models/user.model.js"
import Role from "../models/role.model.js"
import { PERMISSIONS } from "./permissions.js"
import { hashAsync } from "../helpers/hash.js"

async function seedInitialData() {
	const userCount = await User.countDocuments()
	const roleCount = await Role.countDocuments()

	if (userCount > 0 || roleCount > 0) {
		console.log("🔎 Users or roles already exist. Skipping seed.")
		return
	}

	console.log("🌱 Seeding default role and admin user...")

	const adminUserId = new Types.ObjectId()
	const adminRoleId = new Types.ObjectId()
	const vendorRoleId = new Types.ObjectId()
	const adminUserPassword = await hashAsync(process.env.INITIAL_ADMIN_PASS, 10)

	const adminRole = new Role({
		_id: adminRoleId,
		name: "admin",
		status: 1,
		permissions: Object.values(PERMISSIONS).filter((i) => i !== PERMISSIONS.VENDOR_ACCESS)
	})

	const adminUser = new User({
		_id: adminUserId,
		username: "admin",
		password: adminUserPassword,
		passwordStatus: "temporary",
		name: "Admin",
		role: adminRoleId,
		status: 1,
		createdBy: adminUserId
	})

	const vendorRole = new Role({
		_id: vendorRoleId,
		name: "Vendor",
		status: 1,
		permissions: [PERMISSIONS.VENDOR_ACCESS],
		createdBy: adminUserId,
		hidden: true
	})

	await adminRole.save()
	await adminUser.save()
	await vendorRole.save()

	console.log("✅ Seed complete.")
}

export default seedInitialData
