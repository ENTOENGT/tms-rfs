// Rules for the New Transport Request — shared by the form (instant messages) and the server (the real check).

/** Any real phone number: UAE or international. Spaces, dashes, dots and brackets are fine; 7–15 digits. */
export function phoneProblem(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return 'Enter the contact number';
  if (!/^\+?[\d\s().-]+$/.test(s)) return 'A phone number can only have digits, spaces, + - ( )';
  const digits = s.replace(/\D/g, '').replace(/^00/, '');
  if (digits.length < 7 || digits.length > 15) return 'Enter a full phone number, e.g. 050 123 4567 or +44 20 7946 0000';
  return null;
}

/** The company's internal Job No.: kept exactly as typed (letters, numbers, - / . _ spaces), never made up. */
export function jobNoProblem(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return 'Enter the Job No.';
  if (s.length > 40) return 'Job No. can be up to 40 characters';
  if (/[\u0000-\u001f<>]/.test(s)) return 'Job No. has a character that is not allowed';
  return null;
}

/** The six document headings on the request form, in order. */
export const REQUEST_DOCS: [string, string][] = [
  ['shipment_invoice', 'Invoice'], ['packing_list', 'Packing list'], ['boe', 'BOE'], ['bl', 'BL'],
  ['gate_pass', 'Gate pass'], ['supporting_doc', 'Other supporting documents'],
];
