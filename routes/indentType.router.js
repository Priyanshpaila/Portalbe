import express from "express";
import indentTypeModel from "../models/indentType.model.js";

const indentTypeRouter = express.Router();

function cleanCode(x) {
  return String(x ?? "").trim().toUpperCase().replace(/\s+/g, "_");
}

// ✅ Create
indentTypeRouter.post("/", async (req, res, next) => {
  try {
    const payload = req.body || {};
    const code = cleanCode(payload.code);
    const label = String(payload.label ?? "").trim();

    if (!code) return res.status(400).json({ success: false, message: "code is required" });
    if (!label) return res.status(400).json({ success: false, message: "label is required" });

    const created = await indentTypeModel.create({
      code,
      label,
      description: String(payload.description ?? "").trim(),
      sortOrder: Number(payload.sortOrder ?? 0) || 0,
      isActive: payload.isActive !== false,
    });

    return res.status(201).json({ success: true, data: created });
  } catch (err) {
    // duplicate code
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, message: "Indent Type code already exists" });
    }
    next(err);
  }
});

// ✅ List (use activeOnly=true for dropdown)
indentTypeRouter.get("/list", async (req, res, next) => {
  try {
    const { activeOnly } = req.query;

    const match = {};
    if (String(activeOnly).toLowerCase() === "true") match.isActive = true;

    const data = await indentTypeModel
      .find(match)
      .sort({ sortOrder: 1, label: 1 })
      .lean();

    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ✅ Update
indentTypeRouter.put("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    const payload = req.body || {};

    const updates = {};
    if (payload.code != null) updates.code = cleanCode(payload.code);
    if (payload.label != null) updates.label = String(payload.label).trim();
    if (payload.description != null) updates.description = String(payload.description).trim();
    if (payload.sortOrder != null) updates.sortOrder = Number(payload.sortOrder) || 0;
    if (payload.isActive != null) updates.isActive = !!payload.isActive;

    const updated = await indentTypeModel.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ success: false, message: "Indent Type not found" });

    return res.status(200).json({ success: true, data: updated });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, message: "Indent Type code already exists" });
    }
    next(err);
  }
});

export default indentTypeRouter;
