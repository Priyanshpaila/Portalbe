import "dotenv/config";

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import connect from "./lib/db.js";
import { errorHandler } from "./lib/customError.js";
import { authorizeTokens } from "./middlewares/auth.middleware.js";

// ✅ IMPORTANT: import your counter initializer
// change this path to your actual file
import { ensureVendorCounterInitialized } from "./lib/vendorCode.js";

import quotationRouter from "./routes/quotation.routes.js";
import authRouter from "./routes/auth.routes.js";
import userRouter from "./routes/user.routes.js";
import rfqRouter from "./routes/rfq.routes.js";
import csRouter from "./routes/cs.routes.js";
import poRouter from "./routes/po.routes.js";
import indentRouter from "./routes/indent.routes.js";
import negotiationRouter from "./routes/negotiation.routes.js";
import preapprovedVendorRouter from "./routes/preapprovedVendor.router.js";
import vendorRouter from "./routes/vendor.routes.js";
import roleRouter from "./routes/role.routes.js";
import appRouter from "./routes/app.routes.js";

// ❌ REMOVE side-effect imports (unsafe on every restart)
// import "./lib/importIndents.js";
// import "./lib/importVendors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const port = Number(process.env.PORT || 8080);
if (!Number.isFinite(port)) {
  throw new Error("PORT env is missing or invalid");
}

// ✅ middlewares
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ✅ routes
app.use("/api/auth", authRouter);

app.use("/api/indent", authorizeTokens, indentRouter);
app.use("/api/app", authorizeTokens, appRouter);
app.use("/api/vendor", authorizeTokens, vendorRouter);
app.use("/api/rfq", authorizeTokens, rfqRouter);
app.use("/api/negotiation", authorizeTokens, negotiationRouter);
app.use("/api/quotation", authorizeTokens, quotationRouter);
app.use("/api/cs", authorizeTokens, csRouter);
app.use("/api/po", authorizeTokens, poRouter);
app.use("/api/user", authorizeTokens, userRouter);
app.use("/api/role", authorizeTokens, roleRouter);
app.use("/api/preapprovedVendor", preapprovedVendorRouter);

// ✅ uploads
const uploads_dir = path.join(__dirname, "uploads");

// ✅ helper: prevent path traversal
function safeJoin(base, ...paths) {
  const targetPath = path.resolve(base, ...paths);
  if (!targetPath.startsWith(path.resolve(base) + path.sep)) {
    return null;
  }
  return targetPath;
}

// ✅ protect file routes too (recommended)
app.get("/api/file/:id/:filename", authorizeTokens, (req, res) => {
  const { id, filename } = req.params;

  const filePath = safeJoin(uploads_dir, id, filename);
  if (!filePath) return res.status(400).send("Invalid path");

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }
  res.sendFile(filePath);
});

app.get("/api/file/download/:id/:filename", authorizeTokens, (req, res) => {
  const { id, filename } = req.params;

  const filePath = safeJoin(uploads_dir, id, filename);
  if (!filePath) return res.status(400).send("Invalid path");

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }
  res.download(filePath, filename);
});

// ✅ 1) API 404 (do not fall back to index.html)
app.use("/api", (req, res) => {
  return res.status(404).json({ message: "API route not found" });
});

// ✅ 2) Serve frontend build if exists
const buildDir = path.join(__dirname, "./build");
const indexHtml = path.join(buildDir, "index.html");

if (fs.existsSync(indexHtml)) {
  app.use(express.static(buildDir));

  app.get("*", (req, res) => {
    res.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
    res.header("Expires", "-1");
    res.header("Pragma", "no-cache");
    res.sendFile(indexHtml);
  });
} else {
  app.get("*", (req, res) => {
    res
      .status(404)
      .send("Frontend build not found. Build the client or run dev server.");
  });
}

// ✅ keep error handler LAST
app.use(errorHandler);

// ✅ start only after DB is ready + counter is initialized
async function bootstrap() {
  try {
    await connect();
    await ensureVendorCounterInitialized(); // ✅ prevents vendorCode duplicates after imports
    app.listen(port, () =>
      console.log("Consoul server is running on port:", port)
    );
  } catch (err) {
    console.error("Server failed to start:", err);
    process.exit(1);
  }
}

bootstrap();
