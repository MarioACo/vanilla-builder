/*! money-format v2.1.0 | MIT License */
export function formatMoney(value, currency = 'USD', locale = 'en-US') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
}
