import axios from "axios"
import { URLS } from "./constants.js"

export const convertPO = (po) => ({
	Docno: "00000000000001100001",
	Banfn: "2100001",
	AmendNumber: "A01",
	DocumentDate: "/Date(1752710400000)/",
	Ebeln: "4500001234",
	Pocreate: "/Date(1752710400000)/",
	Werks: "PL01",
	Spart: "01",
	Bsart: "NB",
	Refdoctype: "ZPO",
	Name1: "ABC Suppliers Ltd.",
	Lifnr: "V1000",
	Ort01: "Mumbai",
	Contactpername: "Rahul Sharma",
	Serialnumber: "SN12345",
	Validitydate: "/Date(1756598400000)/",
	Departmentname: "Procurement",
	Remarks: "Urgent requirement",
	Paymenttype: "Advance",
	Basedatetype: "PO_DATE",
	Payon: "/Date(1753401600000)/",
	Payvaluepercent: "20",
	Payvalueamount: "10000.00",
	PayDays: "10",
	PaytRemarks: "Initial advance payment",
	Ylevel: "2",
	Yuser: "USER001",
	Assignon: "/Date(1752710400000)/",
	Changedon: "/Date(1752710400000)/",
	Duration: "0000000030",
	Status: "Y",
	Action: "Submit",
	Nextapprover: "MANAGER01",
	Ycomment: "Please",
	Laststatus: "Draft",
	Lastcomment: "Creat"
})

export async function postWithCsrf(payload) {
	try {
		const url = URLS.SAP_PO_URL
		const config = {
			auth: {
				username: process.env.SAP_USERNAME,
				password: process.env.SAP_PASSWORD
			},
			params: {
				"sap-client": 700
			}
		}

		const tokenResponse = await axios.get(url, {
			...config,
			headers: {
				"x-csrf-token": "fetch",
				Accept: "application/json"
			}
		})

		const csrfToken = tokenResponse.headers["x-csrf-token"]
		if (!csrfToken) throw new Error("CSRF token not found")

		const response = await axios.post(url, payload, {
			...config,
			headers: {
				"X-CSRF-Token": csrfToken,
				"Content-Type": "application/json",
				Accept: "application/json"
			}
		})

		return response.data
	} catch (error) {
		console.error("Error in postWithCsrf:", error)
		throw error
	}
}
