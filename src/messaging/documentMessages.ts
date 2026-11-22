import type { BillView, ReceiptView } from '#shared';
import { money } from '../patientDocuments/documentData.ts';

/**
 * The words of a bill or receipt sent to a patient. SMS carries only the hospital name, the document number,
 * the amount and the link, never item names. Email adds a short greeting and the PDF. Both end with how to stop.
 */
export type DocumentMessage = { sms: string; subject: string; text: string; html: string };

const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

/** Keeps an SMS to one part where it can: GSM-7 has no curly quotes or ₦, and names are cut, never the link. */
const smsSafe = (value: string, max: number) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const html = (input: {
  hospital: BillView['hospital'];
  heading: string;
  lines: string[];
  amountLabel: string;
  amount: string;
  url: string;
  button: string;
  attached: string;
  stop: string;
}) => `<!doctype html><html><body style="margin:0;background:#f3f6f4;font-family:Arial,Helvetica,sans-serif;color:#1c211f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d6ddd9;border-radius:12px">
<tr><td style="padding:24px 24px 8px"><div style="font-size:18px;font-weight:bold;color:#0a5433">${esc(input.hospital.name)}</div>
<div style="font-size:13px;color:#5f6b66">${[
  input.hospital.address,
  input.hospital.phone,
  input.hospital.email,
]
  .filter(Boolean)
  .map((v) => esc(v!))
  .join(' · ')}</div></td></tr>
<tr><td style="padding:8px 24px"><h1 style="font-size:20px;margin:8px 0">${esc(input.heading)}</h1>${input.lines.map((l) => `<p style="margin:6px 0;font-size:15px">${esc(l)}</p>`).join('')}
<p style="margin:16px 0 4px;font-size:13px;color:#5f6b66">${esc(input.amountLabel)}</p><p style="margin:0;font-size:24px;font-weight:bold">${esc(input.amount)}</p></td></tr>
<tr><td style="padding:16px 24px"><a href="${esc(input.url)}" style="display:inline-block;background:#0a5433;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">${esc(input.button)}</a>
<p style="font-size:13px;color:#5f6b66;margin:12px 0 0">${esc(input.attached)}</p></td></tr>
<tr><td style="padding:16px 24px 24px;border-top:1px solid #e6ebe8;font-size:12px;color:#5f6b66">Sent by ${esc(input.hospital.name)} using Geneus. Reply to this email to contact the hospital.<br>
<a href="${esc(input.stop)}" style="color:#0a5433">Stop receiving bills and receipts by email</a></td></tr>
</table></td></tr></table></body></html>`;

export const billMessage = (bill: BillView, url: string): DocumentMessage => {
  const due = money(bill.totals.dueMinor, bill.currency);
  const paid = bill.totals.dueMinor === 0;
  const stop = `${url}/messages`;
  const name = smsSafe(bill.hospital.name, 40);

  return {
    sms: paid
      ? `${name}: bill ${bill.reference}, paid in full. View: ${url}`
      : `${name}: bill ${bill.reference}, ${due} due. View and pay: ${url}`,
    subject: `Your bill ${bill.reference} from ${bill.hospital.name}`,
    text: [
      `Hello ${bill.patient.name},`,
      '',
      `${bill.hospital.name} has sent you your bill ${bill.reference}.`,
      paid ? 'It is paid in full.' : `Balance due: ${due}`,
      '',
      `View it online: ${url}`,
      'The invoice is attached as a PDF.',
      '',
      `To stop receiving bills and receipts by email: ${stop}`,
      '',
      bill.hospital.name,
      [bill.hospital.address, bill.hospital.phone].filter(Boolean).join(' · '),
    ]
      .join('\n')
      .trim(),
    html: html({
      hospital: bill.hospital,
      heading: `Your bill ${bill.reference}`,
      lines: [`Hello ${bill.patient.name},`, `${bill.hospital.name} has sent you your bill.`],
      amountLabel: paid ? 'Paid in full' : 'Balance due',
      amount: due,
      url,
      button: paid ? 'View your bill' : 'View and pay your bill',
      attached: 'The invoice is attached as a PDF.',
      stop,
    }),
  };
};

export const receiptMessage = (receipt: ReceiptView, url: string): DocumentMessage => {
  const amount = money(receipt.amountMinor, receipt.currency);
  const stop = `${url}/messages`;
  const name = smsSafe(receipt.hospital.name, 40);
  const what = receipt.reversal ? 'reversal' : 'receipt';

  return {
    sms: receipt.reversal
      ? `${name}: payment ${receipt.number} reversed, ${amount}. Details: ${url}`
      : `${name}: receipt ${receipt.number}, ${amount} paid. Download: ${url}`,
    subject: `Your ${what} ${receipt.number} from ${receipt.hospital.name}`,
    text: [
      `Hello ${receipt.patient.name},`,
      '',
      receipt.reversal
        ? `${receipt.hospital.name} reversed payment ${receipt.number} (${amount}). This is not a new payment.`
        : `Thank you. ${receipt.hospital.name} received ${amount} (receipt ${receipt.number}).`,
      '',
      `View it online: ${url}`,
      'The receipt is attached as a PDF.',
      '',
      `To stop receiving bills and receipts by email: ${stop}`,
      '',
      receipt.hospital.name,
    ].join('\n'),
    html: html({
      hospital: receipt.hospital,
      heading: receipt.reversal
        ? `Payment ${receipt.number} reversed`
        : `Your receipt ${receipt.number}`,
      lines: [
        `Hello ${receipt.patient.name},`,
        receipt.reversal
          ? 'This is not a new payment.'
          : `Thank you for your payment to ${receipt.hospital.name}.`,
      ],
      amountLabel: receipt.reversal ? 'Amount reversed' : 'Amount received',
      amount,
      url,
      button: 'View your receipt',
      attached: 'The receipt is attached as a PDF.',
      stop,
    }),
  };
};
