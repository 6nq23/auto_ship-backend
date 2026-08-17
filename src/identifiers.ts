const compactDigits = (value: string) => value.replace(/\D/g, "");

/** Extract the numeric suffix customers use for a Shopify order reference. */
export const extractOrderSuffix = (value: string): string | undefined => {
  const tagged = value.match(/#?\s*[A-Za-z]{1,8}[\s#:_-]*((?:\d[\s-]*){1,5})(?![\s-]*\d)/);
  if (tagged) return compactDigits(tagged[1]);

  // A standalone 4–5 digit reply is an order suffix. Longer digit strings may
  // be phone numbers, postal PINs, AWBs, or other identifiers.
  if (!/^\s*#?\s*(?:\d[\s-]*){4,5}\s*$/.test(value)) return undefined;
  return compactDigits(value) || undefined;
};

/** Convert customer-entered Shopify order references to the store's #RBD123 format. */
export const normalizeOrderNumber = (value: string): string | undefined => {
  const tagged = value.match(/#?\s*R\s*B\s*D[\s#:_-]*((?:\d[\s-]*){1,5})(?![\s-]*\d)/i);
  if (tagged) {
    const suffix = compactDigits(tagged[1]);
    return suffix ? `#RBD${suffix}` : undefined;
  }

  if (!/^\s*#?\s*(?:\d[\s-]*){4,5}\s*$/.test(value)) return undefined;
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
