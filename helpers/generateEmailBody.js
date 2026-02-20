import { formatDate, toValidDate } from "./formatDate.js";

function safeDateText(d) {
  return toValidDate(d) ? formatDate(d) : "Not specified";
}

function rfq(dueDate, vendorId) {
  return `Dear Authority,

A new enquiry has been submitted on our portal. Kindly log in to the vendor portal and submit your quotation for the mentioned item(s).

Quotation submission deadline: ${safeDateText(dueDate)}

Login link (My Account):
${process.env.FRONTEND_URL}/login/${vendorId}?redirectUrl=/rfqs

If the link does not open, please copy and paste it into your browser.

Regards,
Procurement Team
(Note: This is an automated message. Please do not reply to this email.)`;
}

function po(poNumber, poDate, userId) {
  const path = `login/${userId}?redirectUrl=${encodeURIComponent(
    `/po-authorize?poNumber=${poNumber}`
  )}`;

  return `Dear Authority,

SAP No. / Portal PO No. ${poNumber}, dated ${safeDateText(
    poDate
  )}, has been created and is pending for your approval.

Please log in to review and approve the PO:
${process.env.FRONTEND_URL}/${path}

If the link does not open, please copy and paste it into your browser.

Regards,
Procurement Team
(Note: This is an automated message. Please do not reply to this email.)`;
}

function negotiation(quotationNumber, vendorId) {
  return `Dear Vendor,

A negotiation request has been initiated for Quotation No: ${quotationNumber}.

Please log in to your account to review and respond:
${process.env.FRONTEND_URL}/login/${vendorId}?redirectUrl=${encodeURIComponent(
    `/quotation?quotationNumber=${quotationNumber}`
  )}

If the link does not open, please copy and paste it into your browser.

Regards,
Procurement Team
(Note: This is an automated message. Please do not reply to this email.)
`;
}

export default {
  rfq,
  po,
  negotiation,
};