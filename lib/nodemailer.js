import nodemailer from "nodemailer"

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
  FALLBACK_EMAIL_ADDRESS,
} = process.env

let TRANSPORTER = null

function requireEnv(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing environment variable: ${name}`)
  return v
}

function toBool(v) {
  return String(v).toLowerCase() === "true"
}

async function createTransporter() {
  // Validate required vars once
  requireEnv("SMTP_HOST")
  requireEnv("SMTP_PORT")
  requireEnv("SMTP_USER")
  requireEnv("SMTP_PASS")
  requireEnv("EMAIL_FROM")

  console.time("Initializing SMTP NodeMailer Transporter")

  const transporter = nodemailer.createTransport({
    pool: true,
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: toBool(SMTP_SECURE), // true for 465, false for 587
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
    // Optional hardening / compatibility:
    tls: {
      // If your provider has strict TLS issues, you can tweak this.
      // rejectUnauthorized: true,
    },
  })

  // Verify connection at startup (helps catch wrong creds immediately)
  await transporter.verify()

  console.timeEnd("Initializing SMTP NodeMailer Transporter")
  return transporter
}

async function getTransporter() {
  if (TRANSPORTER) return TRANSPORTER
  TRANSPORTER = await createTransporter()
  return TRANSPORTER
}

/**
 * emailOptions: Array of nodemailer message objects:
 * [
 *   { to, subject, text, html, attachments, cc, bcc, replyTo, ... }
 * ]
 *
 * Returns: { ok: boolean, results: Array<{to, messageId, error}> }
 */
export async function sendMail(emailOptions = []) {
  if (!Array.isArray(emailOptions)) {
    throw new Error("sendMail(emailOptions) expects an array")
  }

  if (emailOptions.length === 0) {
    return { ok: true, results: [] }
  }

  try {
    const transporter = await getTransporter()

    const from = EMAIL_FROM
    const fallbackTo = FALLBACK_EMAIL_ADDRESS || SMTP_USER

    const results = await Promise.all(
      emailOptions.map(async (opt) => {
        try {
          const info = await transporter.sendMail({
            ...opt,
            from,
            to: opt.to || fallbackTo,
          })
          return { to: opt.to || fallbackTo, messageId: info?.messageId || null, error: null }
        } catch (err) {
          console.error("SMTP sendMail error:", err)
          return { to: opt.to || fallbackTo, messageId: null, error: err?.message || String(err) }
        }
      })
    )

    // ok=true only if all succeeded
    const ok = results.every((r) => !r.error)
    return { ok, results }
  } catch (error) {
    console.error("Error sending email:", error)
    throw new Error("Failed to send email")
  }
}