import jwt from "jsonwebtoken";
import userModel from "../models/user.model.js";

export const authorizeTokens = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.split(" ")?.[1];

    if (!token) {
      return res.status(401).send("Authorization token is required");
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded?.userId) {
      return res.status(401).send("Invalid authorization token");
    }

    const user = await userModel.findById(decoded.userId, {
      status: 1,
      username: 1,
      name: 1,
      vendorCode: 1,
      firmId: 1,
      role: 1,
    });

    if (!user) {
      return res.status(401).send("User not found. Please login again.");
    }

    if (Number(user.status) === 0) {
      return res
        .status(403)
        .json({ message: "Your account is inactive. Please contact administrator." });
    }

    req.user = {
      _id: user._id,
      id: user._id,

      vendorCode: user.vendorCode || decoded.vendorCode || null,
      permissions: Array.isArray(decoded.permissions) ? decoded.permissions : [],

      firmId: user.firmId || decoded.firmId || null,
      roleName: decoded.roleName || null,
      role: user.role || null,

      username: user.username,
      name: user.name,
      status: user.status,
    };

    next();
  } catch (error) {
    return res.status(401).send(error.message || "Unauthorized");
  }
};

export function authorizePermissions(...allowedpermissions) {
  return (req, res, next) => {
    const userPermissions = Array.isArray(req.user?.permissions)
      ? req.user.permissions
      : [];

    const isPermitted = allowedpermissions.some((permission) =>
      userPermissions.includes(permission)
    );

    const isValueRoute =
      req.path
        .trim()
        .split("/")
        .filter((i) => i)
        .at(-1) === "values";

    const isAuthRoute = req.path.includes("/reset-password");

    if (!isPermitted && !isValueRoute && !isAuthRoute) {
      return res.status(403).json({ message: "Access denied" });
    }

    next();
  };
}