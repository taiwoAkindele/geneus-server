import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { money, when, type BillView, type ReceiptView } from './documentData.ts';

/**
 * Standard A4 business documents: an invoice for a bill and a payment receipt. Built with pdf-lib's standard
 * Helvetica, which every PDF reader has, so they look the same on phones, computers and printers. Long
 * documents continue on further pages with the table header repeated and "Page n of m" at the foot.
 */
const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const FOOTER = 40;
const INK = rgb(0.11, 0.13, 0.12), SOFT = rgb(0.38, 0.42, 0.4), LINE = rgb(0.82, 0.85, 0.83), BRAND = rgb(0.04, 0.33, 0.2), WASH = rgb(0.93, 0.96, 0.94);

/**
 * Helvetica covers Western European text only. Accents are dropped (Ọlá → Ola) and anything else outside it
 * becomes "?", so a name can never stop a PDF being made.
 */
const KEEP = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
export const pdfSafe = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ')
  .split('').map((ch) => (ch.charCodeAt(0) <= 0xff || KEEP.has(ch) ? ch : '?')).join('');

type Column = { label: string; width: number; align?: 'right' };

class Layout {
  doc: PDFDocument; regular: PDFFont; bold: PDFFont; page!: PDFPage; y = 0; pages: PDFPage[] = [];
  private constructor(doc: PDFDocument, regular: PDFFont, bold: PDFFont) { this.doc = doc; this.regular = regular; this.bold = bold; }
  static async create(title: string) {
    const doc = await PDFDocument.create();
    doc.setTitle(pdfSafe(title)); doc.setProducer('Geneus'); doc.setCreator('Geneus');
    const layout = new Layout(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
    layout.newPage();
    return layout;
  }
  newPage() { this.page = this.doc.addPage([A4.width, A4.height]); this.pages.push(this.page); this.y = A4.height - MARGIN; }
  get right() { return A4.width - MARGIN; }
  get width() { return A4.width - 2 * MARGIN; }
  /** Starts a new page when fewer than `height` points are left above the footer; returns whether it did. */
  ensure(height: number) { if (this.y - height < MARGIN + FOOTER) { this.newPage(); return true; } return false; }
  text(value: string, x: number, options: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; align?: 'right'; y?: number } = {}) {
    const font = options.bold ? this.bold : this.regular, size = options.size ?? 10, safe = pdfSafe(value);
    const at = options.align === 'right' ? x - font.widthOfTextAtSize(safe, size) : x;
    this.page.drawText(safe, { x: at, y: options.y ?? this.y, size, font, color: options.color ?? INK });
  }
  /** Splits text into lines no wider than `width`, breaking long words when they must. */
  wrap(value: string, width: number, size = 10, bold = false): string[] {
    const font = bold ? this.bold : this.regular, fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
    const lines: string[] = []; let line = '';
    for (const word of pdfSafe(value).split(' ')) {
      let rest = word;
      while (!fits(rest)) { let cut = rest.length - 1; while (cut > 1 && !fits(rest.slice(0, cut))) cut--; if (line) { lines.push(line); line = ''; } lines.push(rest.slice(0, cut)); rest = rest.slice(cut); }
      const next = line ? `${line} ${rest}` : rest;
      if (fits(next)) line = next; else { lines.push(line); line = rest; }
    }
    if (line || !lines.length) lines.push(line);
    return lines;
  }
  rule(color = LINE) { this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: this.right, y: this.y }, thickness: 0.75, color }); }
  /** The document's letterhead: hospital on the left, the document title on the right. */
  letterhead(hospital: BillView['hospital'], title: string) {
    const top = this.y;
    this.text(hospital.name, MARGIN, { size: 16, bold: true, color: BRAND });
    let y = top - 16;
    for (const line of [hospital.address, hospital.phone, hospital.email].filter((v): v is string => Boolean(v))) {
      for (const part of this.wrap(line, this.width * 0.55, 9)) { this.text(part, MARGIN, { size: 9, color: SOFT, y }); y -= 12; }
    }
    this.text(title, this.right, { size: 20, bold: true, align: 'right', y: top - 2 });
    this.y = Math.min(y, top - 30) - 10; this.rule(BRAND); this.y -= 22;
  }
  /** Label/value pairs in two columns: the left block and the right block side by side. */
  facts(left: { heading: string; lines: string[] }, right: [string, string][]) {
    const top = this.y;
    this.text(left.heading.toUpperCase(), MARGIN, { size: 8, bold: true, color: SOFT });
    let y = top - 14;
    left.lines.forEach((line, i) => { this.text(line, MARGIN, { size: i ? 9 : 11, bold: i === 0, y, color: i ? SOFT : INK }); y -= i ? 12 : 14; });
    let ry = top;
    for (const [label, value] of right) {
      this.text(label, this.right - 170, { size: 9, color: SOFT, y: ry }); this.text(value, this.right, { size: 9, bold: true, align: 'right', y: ry }); ry -= 14;
    }
    this.y = Math.min(y, ry) - 16;
  }
  tableHeader(columns: Column[]) {
    this.page.drawRectangle({ x: MARGIN, y: this.y - 6, width: this.width, height: 20, color: WASH });
    let x = MARGIN + 6;
    for (const c of columns) { this.text(c.label, c.align ? x + c.width - 12 : x, { size: 8, bold: true, color: SOFT, align: c.align, y: this.y }); x += c.width; }
    this.y -= 22;
  }
  /** A table row; wraps the first column and repeats the header on a new page. */
  tableRow(columns: Column[], cells: string[], options: { bold?: boolean; header?: boolean } = {}) {
    const lines = this.wrap(cells[0], columns[0].width - 12, 9, options.bold);
    if (this.ensure(lines.length * 12 + 8)) this.tableHeader(columns);
    let x = MARGIN + 6;
    columns.forEach((c, i) => {
      if (i === 0) lines.forEach((line, n) => this.text(line, x, { size: 9, bold: options.bold, y: this.y - n * 12 }));
      else this.text(cells[i] ?? '', x + c.width - 12, { size: 9, bold: options.bold, align: 'right' });
      x += c.width;
    });
    this.y -= lines.length * 12 + 6; this.rule(); this.y -= 12;
  }
  /** A right-aligned totals line. */
  total(label: string, value: string, strong = false) {
    this.ensure(18);
    this.text(label, this.right - 140, { size: strong ? 11 : 9, bold: strong, align: 'right', color: strong ? INK : SOFT });
    this.text(value, this.right, { size: strong ? 11 : 9, bold: strong, align: 'right' });
    this.y -= strong ? 18 : 14;
  }
  heading(value: string) { this.ensure(40); this.y -= 6; this.text(value.toUpperCase(), MARGIN, { size: 8, bold: true, color: SOFT }); this.y -= 16; }
  paragraph(value: string, size = 9, color = SOFT) { for (const line of this.wrap(value, this.width, size)) { this.ensure(14); this.text(line, MARGIN, { size, color }); this.y -= size + 4; } }
  async finish(footer: string) {
    this.pages.forEach((page, i) => {
      const label = `Page ${i + 1} of ${this.pages.length}`;
      page.drawText(pdfSafe(footer), { x: MARGIN, y: MARGIN - 8, size: 8, font: this.regular, color: SOFT });
      page.drawText(label, { x: this.right - this.regular.widthOfTextAtSize(label, 8), y: MARGIN - 8, size: 8, font: this.regular, color: SOFT });
    });
    return this.doc.save();
  }
}

const generated = (timeZone: string, now: Date) => `Generated from the hospital's records on ${when(now.toISOString(), timeZone, true)}`;
const ITEM_COLUMNS = (width: number): Column[] => [{ label: 'Description', width: width - 255 }, { label: 'Qty', width: 45, align: 'right' }, { label: 'Unit price', width: 105, align: 'right' }, { label: 'Amount', width: 105, align: 'right' }];

export const invoicePdf = async (bill: BillView, link: string, now = new Date()): Promise<Uint8Array> => {
  const l = await Layout.create(`Invoice ${bill.reference}`), m = (minor: number) => money(minor, bill.currency), tz = bill.hospital.timeZone;
  l.letterhead(bill.hospital, 'INVOICE');
  l.facts({ heading: 'Bill to', lines: [bill.patient.name, `Patient ID ${bill.patient.patientId}`, ...(bill.patient.phone ? [bill.patient.phone] : [])] },
    [['Invoice number', bill.reference], ['Issue date', when(bill.issuedOn, tz)], ['Status', bill.status]]);
  const columns = ITEM_COLUMNS(l.width);
  l.tableHeader(columns);
  for (const category of [...new Set(bill.lines.map((line) => line.category))]) {
    l.tableRow(columns, [category, '', '', ''], { bold: true });
    for (const line of bill.lines.filter((x) => x.category === category)) {
      l.tableRow(columns, [line.exempt ? `${line.description} (exempt)` : line.description, String(line.quantity), m(line.unitMinor), m(line.amountMinor)]);
    }
  }
  const t = bill.totals;
  l.y -= 4;
  l.total('Subtotal', m(t.subtotalMinor));
  if (t.exemptMinor) l.total('Exemptions', `- ${m(t.exemptMinor)}`);
  if (t.reducedMinor) l.total('Discounts and waivers', `- ${m(t.reducedMinor)}`);
  if (t.insuranceMinor) l.total('Insurance pays', `- ${m(t.insuranceMinor)}`);
  if (t.undecidedMinor) l.total('Awaiting insurance decision', `- ${m(t.undecidedMinor)}`);
  l.total('Total', m(t.totalMinor), true);
  l.total('Amount paid', m(t.paidMinor));
  l.total('Balance due', m(t.dueMinor), true);
  if (t.creditMinor) l.total('Credit held for you', m(t.creditMinor));
  if (t.undecidedMinor) l.paragraph('Part of this bill is waiting for your insurer\'s decision. It is not included in the balance due; the hospital will tell you if you need to pay any of it.');
  // How to pay: the bill's link and a QR code for scanning it from paper.
  l.ensure(130); l.heading('View and pay this bill online');
  const qr = await l.doc.embedPng(await QRCode.toBuffer(link, { type: 'png', margin: 1, width: 300, errorCorrectionLevel: 'M' }));
  const top = l.y + 8;
  l.page.drawImage(qr, { x: l.right - 96, y: top - 96, width: 96, height: 96 });
  for (const line of l.wrap(link, l.width - 120, 9)) { l.text(line, MARGIN, { size: 9, color: BRAND }); l.y -= 13; }
  l.y -= 4;
  for (const line of l.wrap('Scan the code or open the link to see this bill and download it. Please quote the invoice number when you contact the hospital about it.', l.width - 120, 9)) { l.text(line, MARGIN, { size: 9, color: SOFT }); l.y -= 13; }
  l.y = Math.min(l.y, top - 104);
  return l.finish(generated(tz, now));
};

export const receiptPdf = async (receipt: ReceiptView, now = new Date()): Promise<Uint8Array> => {
  const l = await Layout.create(`Receipt ${receipt.number}`), m = (minor: number) => money(minor, receipt.currency), tz = receipt.hospital.timeZone;
  l.letterhead(receipt.hospital, 'PAYMENT RECEIPT');
  if (receipt.reversal) { l.page.drawRectangle({ x: MARGIN, y: l.y - 8, width: l.width, height: 24, color: rgb(0.99, 0.93, 0.9) }); l.text('REVERSAL · not a new payment', MARGIN + 8, { bold: true, color: rgb(0.6, 0.15, 0.1) }); l.y -= 30; }
  l.facts({ heading: 'Received from', lines: [receipt.patient.name, `Patient ID ${receipt.patient.patientId}`] },
    [['Receipt number', receipt.number], ['Date', when(receipt.receivedOn, tz, true)], ['Method', receipt.method], ...(receipt.reference ? [['Reference', receipt.reference] as [string, string]] : [])]);
  const columns: Column[] = [{ label: 'Bill · item', width: l.width - 105 }, { label: 'Amount applied', width: 105, align: 'right' }];
  l.tableHeader(columns);
  for (const a of receipt.applied) l.tableRow(columns, [`${a.bill} · ${a.item}`, m(a.amountMinor)]);
  l.y -= 4;
  l.total(receipt.reversal ? 'Amount reversed' : 'Amount received', m(receipt.amountMinor), true);
  for (const b of receipt.stillDue) l.total(`Still due on ${b.bill}`, m(b.dueMinor));
  l.y -= 6; l.paragraph(`Received by: ${receipt.receivedBy}`);
  return l.finish(generated(tz, now));
};
