import { formatDate, toValidDate } from "./formatDate.js";

function safeDateText(d) {
  return toValidDate(d) ? formatDate(d) : "Not specified";
}

function rfq(dueDate, vendorId) {
  return `Dear Authority,



We would like to inform you that new enquiry has been submitted in our portal. Kindly provide quotation for mention item by login in to our vendor portal.

Last date of quotation submission is ${safeDateText(dueDate)}.

Please click on the below link to login to My Account:

${process.env.FRONTEND_URL}/login/${vendorId}?redirectUrl=/rfqs`;
}

function po(poNumber, poDate, userId) {
  const path = `login/${userId}?redirectUrl=${encodeURIComponent(
    `/po-authorize?poNumber=${poNumber}`
  )}`;

  return `Dear Authority,



SAP No. Portal PO No. ${poNumber}, Dated - ${safeDateText(
    poDate
  )} has been created. It is pending for your approval.

For more detail login at:

${process.env.FRONTEND_URL}/${path}`;
}

function negotiation(quotationNumber, vendorId) {
  return `Negotiation request for Quotation No : ${quotationNumber} has been submitted.
Please click on the below link to login to My Account:

${process.env.FRONTEND_URL}/login/${vendorId}?redirectUrl=${encodeURIComponent(
    `/quotation?quotationNumber=${quotationNumber}`
  )}
`;
}

export default {
  rfq,
  po,
  negotiation,
};
