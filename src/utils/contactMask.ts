const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MOBILE = /(?<!\d)(?:\+?91[\s().-]*)?[6-9](?:[\s().-]*\d){9}(?!\d)/g;

export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at < 1) return maskContactText(value);
  const local = value.slice(0, at);
  return `${local[0]}******${local.length > 1 ? local.at(-1) : ''}${value.slice(at)}`;
}

export function maskMobile(value: string): string {
  const digits = value.replace(/\D/g, '');
  const number = digits.length >= 10 ? digits.slice(-10) : digits;
  return number ? `${number[0]}***${number.length > 1 ? number.at(-1) : ''}` : '';
}

export function maskContactText(value: string): string {
  return value.replace(EMAIL, maskEmail).replace(MOBILE, maskMobile);
}

export function maskContactData<T>(value: T, key = ''): T {
  if (Array.isArray(value)) return value.map((item) => maskContactData(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, maskContactData(item, field)])) as T;
  }
  if (typeof value !== 'string') return value;
  if (/e.?mail/i.test(key) && value.includes('@')) return maskEmail(value) as T;
  if (/(?:mobile|phone|telephone|whatsapp)/i.test(key)) return maskMobile(value) as T;
  return maskContactText(value) as T;
}
