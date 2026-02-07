import express from "express"
import User from "../models/user.model.js"
import { createError } from "../lib/customError.js"
import { dataTable } from "../helpers/dataTable.js"
import userModel from "../models/user.model.js"
import { PERMISSIONS } from "../lib/permissions.js"
import { compareAsync, hashAsync } from "../helpers/hash.js"
import { authorizePermissions } from "../middlewares/auth.middleware.js"
import upload from "../middlewares/upload.middleware.js"
import { Types } from "mongoose"
import fs from "fs/promises"
import roleModel from "../models/role.model.js"

const userRouter = express.Router()

userRouter.post(
	"/",
	authorizePermissions(PERMISSIONS.ACCESS_CONTROL),
	(req, res, next) => {
		req.params.id = new Types.ObjectId().toString()
		next()
	},
	upload.single("digitalSignature"),
	async (req, res, next) => {
		try {
			const { username, password, name, role, permissions, ...data } = req.body
			if (req.file) data.digitalSignature = req.file.filename

			const hashedPassword = await hashAsync(password, 10)
			const newUser = new User({
				_id: req.params.id,
				username,
				password: hashedPassword,
				passwordStatus: "temporary",
				createdBy: req?.user?._id,
				name,
				permissions,
				role,
				...data
			})
			await newUser.save()
			res.status(201).json(newUser)
		} catch (error) {
			next(error)
		}
	}
)

userRouter.post("/list", async (req, res, next) => {
	try {
		const { query, ...params } = req.body

		params.matchQuery = [{ $match: { status: 1 } }]

		if (query)
			params.matchQuery.push({
				$match: {
					$or: [{ name: { $regex: query } }, { username: { $regex: query } }]
				}
			})

		const response = await dataTable(params, userModel, [
			{
				$lookup: {
					from: "roles",
					localField: "role",
					foreignField: "_id",
					pipeline: [
						{
							$project: {
								name: 1
							}
						}
					],
					as: "role"
				}
			},
			{
				$lookup: {
					from: "users",
					localField: "createdBy",
					foreignField: "_id",
					pipeline: [
						{
							$project: {
								name: 1
							}
						}
					],
					as: "createdBy"
				}
			},
			{
				$set: {
					role: {
						$first: "$role.name"
					},
					createdBy: {
						$first: "$createdBy.name"
					}
				}
			}
		])

		res.status(200).send(response)
	} catch (error) {
		next(error)
	}
})

userRouter.get("/", async (req, res, next) => {
	try {
		const users = await User.aggregate([
			{
				$lookup: {
					from: "users",
					localField: "createdBy",
					foreignField: "_id",
					pipeline: [
						{
							$project: {
								name: 1
							}
						}
					],
					as: "createdBy"
				}
			},
			{
				$set: {
					createdBy: {
						$first: "$createdBy.name"
					}
				}
			},
			{
				$unset: "password"
			}
		])
		res.status(200).json(users)
	} catch (error) {
		next(error)
	}
})

userRouter.get("/po-vendors", async (req, res, next) => {
	try {
		const roles = await roleModel.find({ permissions: { $in: [PERMISSIONS.AUTHORIZE_PO] } }, { _id: 1 })
		const users = await User.aggregate([
			{
				$match: {
					role: {
						$in: roles.map((i) => i._id)
					}
				}
			},
			{
				$project: {
					_id: 1,
					username: 1,
					name: 1
				}
			}
		])
		res.status(200).json(users)
	} catch (error) {
		next(error)
	}
})

userRouter.get("/:id", async (req, res, next) => {
	try {
		const user = await User.findById(req.params.id, { password: 0 })
		if (!user) throw createError("User not found", 404)
		res.status(200).json(user)
	} catch (error) {
		next(error)
	}
})

userRouter.put(
	"/:id",
	authorizePermissions(PERMISSIONS.ACCESS_CONTROL),
	upload.single("digitalSignature"),
	async (req, res, next) => {
		try {
			let { username, name, permissions, vendorCode, email, role, digitalSignature } = req.body
			if (req.file) {
				digitalSignature = req.file.filename

				const currData = await User.findById(req.params.id, { digitalSignature: 1 })
				if (currData.digitalSignature)
					await fs.rm(`uploads/${req.params.id}/${currData.digitalSignature}`, { force: true })
			}

			const updatedData = { username, name, permissions, vendorCode, email, role, digitalSignature }
			const user = await User.findByIdAndUpdate(req.params.id, updatedData, { new: true })
			if (!user) throw createError("User not found", 404)
			res.status(200).json(user)
		} catch (error) {
			next(error)
		}
	}
)

userRouter.delete("/:id", authorizePermissions(PERMISSIONS.ACCESS_CONTROL), async (req, res, next) => {
	try {
		const user = await User.findByIdAndDelete(req.params.id)
		if (!user) throw createError("User not found", 404)
		if (user.digitalSignature) await fs.rm("uploads/" + req.params.id, { recursive: true, force: true })
		res.status(200).json({ message: "User deleted successfully" })
	} catch (error) {
		next(error)
	}
})

userRouter.post("/reset-password", async (req, res, next) => {
	try {
		const { password } = req.body
		const user = await User.findById(req.user._id)
		const resetBySelf = req.user._id === user._id.toString()

		if (!user) throw createError("User not found", 404)
		if ((await compareAsync(password, user.password)) && resetBySelf)
			throw createError("New password must be different from previous password.", 405)

		user.password = await hashAsync(password, 10)
		user.passwordStatus = resetBySelf ? "permanent" : "temporary"

		await user.save()

		res.status(200).json({ message: "Password reset successfully" })
	} catch (error) {
		next(error)
	}
})

// ✅ Admin gets all users, others get only self
userRouter.get("/me-or-all", async (req, res, next) => {
  try {
    // 1) Load logged-in user with role populated
    const me = await User.findById(req.user._id).populate("role", "name");
    if (!me) throw createError("User not found", 404);

    const roleName = String(me?.role?.name || "").toLowerCase();
    const isAdmin = roleName === "admin"; // ✅ if your role name differs, adjust this check

    // 2) If not admin: return only self (without password)
    if (!isAdmin) {
      const self = await User.findById(req.user._id, { password: 0 }).populate("role", "name");
      return res.status(200).json([self]); // return array for same shape as admin response
    }

    // 3) Admin: return all users with details (same as your GET "/")
    const users = await User.aggregate([
      {
        $lookup: {
          from: "roles",
          localField: "role",
          foreignField: "_id",
          pipeline: [{ $project: { name: 1 } }],
          as: "role",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          pipeline: [{ $project: { name: 1 } }],
          as: "createdBy",
        },
      },
      {
        $set: {
          role: { $first: "$role.name" },
          createdBy: { $first: "$createdBy.name" },
        },
      },
      { $unset: "password" },
    ]);

    return res.status(200).json(users);
  } catch (error) {
    next(error);
  }
});

export default userRouter
