const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MOBILE = /(?<!\d)(?:\+?91[\s().-]*)?[6-9](?:[\s().-]*\d){9}(?!\d)/g;

export function maskEmail(value) {
  const email = String(value || '');
  const at = email.lastIndexOf('@');
  if (at < 1) return maskContactText(email);
  const local = email.slice(0, at);
  return `${local[0]}******${local.length > 1 ? local.at(-1) : ''}${email.slice(at)}`;
}

export function maskMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const number = digits.length >= 10 ? digits.slice(-10) : digits;
  return number ? `${number[0]}***${number.length > 1 ? number.at(-1) : ''}` : '';
}

export function maskContactText(value) {
  return String(value ?? '').replace(EMAIL, maskEmail).replace(MOBILE, maskMobile);
}

export function maskContactData(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => maskContactData(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, maskContactData(item, field)]));
  }
  if (typeof value !== 'string') return value;
  if (/e.?mail/i.test(key) && value.includes('@')) return maskEmail(value);
  if (/(?:mobile|phone|telephone|whatsapp)/i.test(key)) return maskMobile(value);
  return maskContactText(value);
}
