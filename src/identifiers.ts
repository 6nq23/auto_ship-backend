const compactDigits = (value: string) => value.replace(/\D/g, "");

/** Convert customer-entered Shopify order references to the store's #RBD123 format. */
export const normalizeOrderNumber = (value: string): string | undefined => {
  const tagged = value.match(/#?\s*R\s*B\s*D[\s#:_-]*((?:\d[\s-]*){1,18})/i);
  if (tagged) {
    const suffix = compactDigits(tagged[1]);
    return suffix ? `#RBD${suffix}` : undefined;
  }

  // A short, digits-only reply is an order suffix. Ten or more digits is a phone.
  if (!/^\s*#?\s*(?:\d[\s-]*){3,9}\s*$/.test(value)) return undefined;
  const suffix = compactDigits(value);
  return suffix ? `#RBD${suffix}` : undefined;
};

/** Normalize an Indian mobile number, accepting +91, 91, 0091 and punctuation. */
export const normalizePhoneNumber = (value: string): string | undefined => {
  const digits = compactDigits(value);
  if (digits.length < 10 || digits.length > 15) return undefined;
  const local = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(local) ? local : undefined;
};

export const extractPhoneNumber = (text: string): string | undefined => {
  const candidates = text.match(/(?:\+|00)?\d(?:[\s().-]*\d){9,14}/g) || [];
  return candidates.map(normalizePhoneNumber).find((phone): phone is string => Boolean(phone));
};
