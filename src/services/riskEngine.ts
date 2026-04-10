type RiskInputs = {
  poolTotalValueUsd: number;
  poolTotalExposureUsd: number;
  maxPerMatchPct: number; // e.g. 3
  maxTotalExposurePct: number; // e.g. 20
};

export function isWithinRisk({
  poolTotalValueUsd,
  poolTotalExposureUsd,
  maxPerMatchPct,
  maxTotalExposurePct,
  proposedMatchExposureUsd
}: RiskInputs & { proposedMatchExposureUsd: number }) {
  const maxPerMatch = (poolTotalValueUsd * maxPerMatchPct) / 100;
  const maxTotalExposure = (poolTotalValueUsd * maxTotalExposurePct) / 100;
  const afterTotalExposure = poolTotalExposureUsd + proposedMatchExposureUsd;

  return {
    maxPerMatch,
    maxTotalExposure,
    ok: proposedMatchExposureUsd <= maxPerMatch && afterTotalExposure <= maxTotalExposure
  };
}

