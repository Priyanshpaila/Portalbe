import Razorpay from "razorpay";
import crypto from "crypto";

const key_id = process.env.RAZORPAY_KEY_ID;
const key_secret = process.env.RAZORPAY_KEY_SECRET;
const webhook_secret = process.env.RAZORPAY_WEBHOOK_SECRET;

if (!key_id || !key_secret) {
  console.warn("⚠️ Razorpay env missing: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET");
}
if (!webhook_secret) {
  console.warn("⚠️ Razorpay env missing: RAZORPAY_WEBHOOK_SECRET");
}

export const razorpay = new Razorpay({
  key_id,
  key_secret,
});

export function verifyRazorpaySignature({ orderId, paymentId, signature }) {
  const body = `${orderId}|${paymentId}`;
  const expected = crypto
    .createHmac("sha256", key_secret)
    .update(body)
    .digest("hex");

  return expected === signature;
}

export function verifyRazorpayWebhookSignature({ rawBody, signature }) {
  if (!webhook_secret) return false;
  if (!rawBody || !Buffer.isBuffer(rawBody)) return false;

  const expected = crypto
    .createHmac("sha256", webhook_secret)
    .update(rawBody)
    .digest("hex");

  // timing-safe compare
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || "").trim());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function getRazorpayKeyId() {
  return key_id;
}