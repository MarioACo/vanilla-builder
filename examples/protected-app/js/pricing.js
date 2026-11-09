// Business logic you may not want to ship in plain text.
const TIERS = [
  { from: 1, unit: 19.9 },
  { from: 10, unit: 17.5 },
  { from: 50, unit: 14.25 },
];

export function priceFor(quantity) {
  const tier = [...TIERS].reverse().find((t) => quantity >= t.from) ?? TIERS[0];
  const discount = quantity >= 100 ? 0.05 : 0;
  return Math.round(quantity * tier.unit * (1 - discount) * 100) / 100;
}
