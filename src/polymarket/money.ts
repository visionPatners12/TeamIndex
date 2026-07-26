export function decimalToBaseUnits(value: string | number, decimals = 6): bigint {
  const raw = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`Invalid unsigned decimal amount: ${raw}`);
  const [whole, fraction = ""] = raw.split(".");
  const extra = fraction.slice(decimals);
  if (extra && /[1-9]/.test(extra)) throw new Error(`Amount has more than ${decimals} significant decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction.slice(0, decimals) + "0".repeat(decimals)).slice(0, decimals));
}

export function baseUnitsToDecimal(value: bigint, decimals = 6): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function decimalToSdkNumber(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid ${label}`);
  return parsed;
}
