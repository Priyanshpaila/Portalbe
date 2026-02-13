import crypto from "crypto";

export function verifyRazorpayWebhookSignature({ rawBody, signature, secret }) {
  const sig = String(signature || "").trim();
  if (!secret) return { ok: false, reason: "MISSING_SECRET" };
  if (!rawBody || !Buffer.isBuffer(rawBody)) return { ok: false, reason: "MISSING_RAW_BODY" };
  if (!sig) return { ok: false, reason: "MISSING_SIGNATURE" };

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(sig);

  if (a.length !== b.length) return { ok: false, reason: "SIGNATURE_LENGTH_MISMATCH" };

  const match = crypto.timingSafeEqual(a, b);
  return { ok: match, expected };
}