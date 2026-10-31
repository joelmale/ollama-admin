export type VramFit = "comfortable" | "tight" | "exceeds";

export interface VramAssessment {
  neededGB: number;
  pct: number;
  fit: VramFit;
}

const GB_PER_BILLION_PARAMS_Q4 = 0.55;
const COMFORTABLE_MAX_PCT = 75;

export function parseTagToSizeGB(tag: string): number | null {
  const normalized = tag.toLowerCase().replace(/^e(\d)/, "$1");
  const match = normalized.match(/^(?:(\d+)x)?(\d+(?:\.\d+)?)([bm])$/);
  if (!match) return null;
  const experts = match[1] ? parseInt(match[1], 10) : 1;
  const params = parseFloat(match[2]) * experts;
  const billions = match[3] === "m" ? params / 1000 : params;
  return billions * GB_PER_BILLION_PARAMS_Q4;
}

// Weights plus ~10% runtime buffers and a fixed allowance for the KV cache at the default context.
export function estimateVramGB(weightsGB: number): number {
  return weightsGB * 1.1 + 0.5;
}

export function assessVramFit(neededGB: number, vramGB: number): VramAssessment {
  const pct = vramGB > 0 ? (neededGB / vramGB) * 100 : Infinity;
  let fit: VramFit = "exceeds";
  if (pct <= COMFORTABLE_MAX_PCT) fit = "comfortable";
  else if (pct <= 100) fit = "tight";
  return { neededGB, pct, fit };
}

export function vramFitColor(fit: VramFit): string {
  switch (fit) {
    case "comfortable": return "hsl(142 71% 45%)";
    case "tight": return "hsl(38 92% 50%)";
    case "exceeds": return "hsl(0 84% 60%)";
  }
}

export function vramFitBg(fit: VramFit): string {
  switch (fit) {
    case "comfortable": return "hsl(142 71% 45% / 0.15)";
    case "tight": return "hsl(38 92% 50% / 0.15)";
    case "exceeds": return "hsl(0 84% 60% / 0.15)";
  }
}
