import { formatDate } from "./formatDate.js"

function rfq(dueDate, vendorId) {
	return `Dear Authority,

Greetings from R.R.ISPAT (A UNIT OF GODAWARI POWER & ISPAT LTD.)!

We would like to inform you that new enquiry has been submitted in our portal. Kindly provide quotation for mention item by login in to our vendor portal.

Last date of quotation submission is ${formatDate(dueDate)}.

Please click on the below link to login to My Account:

${process.env.FRONTEND_URL}/login/${vendorId}?redirectUrl=/rfqs

Warm Regards,

R.R.ISPAT (A UNIT OF GODAWARI POWER & ISPAT LTD.)`
}

function po(poNumber, poDate, userId) {
	const path = `login/${userId}?redirectUrl=${encodeURIComponent(`/po-authorize?poNumber=${poNumber}`)}`
	return `Dear Authority,

Greetings from R.R.ISPAT (A UNIT OF GODAWARI POWER & ISPAT LTD.)

SAP No. Portal PO No. ${poNumber}, Dated - ${formatDate(poDate)} has been created. It is pending for your approval.

For more detail login at:

If you are connected to Local Hira Network then use below link

http://192.168.12.11:9898/${path}

If you are Not connected to Local Hira Network then use below link

${process.env.FRONTEND_URL}/${path}`
}

function negotiation(quotationNumber, vendorId) {
	return `Negotiation request for Quotation No : ${quotationNumber} has been submitted.
Please click on the below link to login to My Account:

${process.env.FRONTEND_URL}/login/${vendorId}?redirectUrl=${encodeURIComponent(
		`/quotation?quotationNumber=${quotationNumber}`
	)}

Warm Regards,
R.R.ISPAT (A UNIT OF GODAWARI POWER & ISPAT LTD.)`
}

export default {
	rfq,
	po,
	negotiation
}
