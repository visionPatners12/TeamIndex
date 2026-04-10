"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isWithinRisk = isWithinRisk;
function isWithinRisk({ poolTotalValueUsd, poolTotalExposureUsd, maxPerMatchPct, maxTotalExposurePct, proposedMatchExposureUsd }) {
    const maxPerMatch = (poolTotalValueUsd * maxPerMatchPct) / 100;
    const maxTotalExposure = (poolTotalValueUsd * maxTotalExposurePct) / 100;
    const afterTotalExposure = poolTotalExposureUsd + proposedMatchExposureUsd;
    return {
        maxPerMatch,
        maxTotalExposure,
        ok: proposedMatchExposureUsd <= maxPerMatch && afterTotalExposure <= maxTotalExposure
    };
}
