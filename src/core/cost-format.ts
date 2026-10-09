/** Small nonzero charges must not round to a displayed zero. Full numbers remain in JSON. */
export function formatCostUsd(value: number): string {
  if (!Number.isFinite(value)) return 'Unknown';
  if (value === 0) return '$0';
  if (Math.abs(value) < 0.000001) return `$${value.toExponential(4)}`;
  return `$${Number(value.toPrecision(8))}`;
}
