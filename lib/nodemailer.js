import nodemailer from "nodemailer"
import { google } from "googleapis"

let ACCESS_TOKEN = null
let ACCESS_TOKEN_EXPIRY = null

const { EMAIL, REFRESH_TOKEN, CLIENT_SECRET, CLIENT_ID } = process.env
const OAuth2 = google.auth.OAuth2

const getAccessToken = async () => {
	if (ACCESS_TOKEN_EXPIRY - Date.now() > 5000) return ACCESS_TOKEN

	const oauth2Client = new OAuth2(CLIENT_ID, CLIENT_SECRET, "https://developers.google.com/oauthplayground")

	oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN })
	const accessToken = await new Promise((resolve, reject) => {
		oauth2Client.getAccessToken((err, token, res) => {
			if (err) return reject(`Failed to create access token: ${err.message} :(`)

			ACCESS_TOKEN = token
			ACCESS_TOKEN_EXPIRY = res.data.expiry_date

			resolve(token)
		})
	})

	return accessToken
}

const createTransporter = async () => {
	const accessToken = await getAccessToken()
	console.time("Initializing NodeMailer Transporter")
	const transporter = nodemailer.createTransport({
		pool: true,
		service: "gmail",
		host: "smtp.gmail.com",
		secure: true,
		port: 465,
		auth: {
			type: "OAuth2",
			user: EMAIL,
			accessToken,
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			refreshToken: REFRESH_TOKEN
		}
	})
	console.timeEnd("Initializing NodeMailer Transporter")
	return transporter
}

export const sendMail = (emailOptions) =>
	new Promise(async (resolve, reject) => {
		try {
			let emailTransporter = await createTransporter()
			await Promise.all(
				emailOptions.map((i) => {
					emailTransporter.sendMail(
						{ ...i, from: EMAIL, to: i.to || process.env.FALLBACK_EMAIL_ADDRESS },
						(err, info) => {
							if (err) resolve(null)
							resolve(info?.messageId)
						}
					)
				})
			)
			resolve(true)
		} catch (error) {
			console.error("Error sending email:", error)
			reject(`Failed to send email`)
		}
	})
