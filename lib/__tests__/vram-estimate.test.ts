import { describe, expect, it } from "vitest";
import {
  assessVramFit,
  estimateVramGB,
  parseTagToSizeGB,
  vramFitBg,
  vramFitColor,
  type VramFit,
} from "@/lib/vram-estimate";

describe("parseTagToSizeGB", () => {
  it("estimates Q4 weights from billions of parameters", () => {
    expect(parseTagToSizeGB("8b")).toBeCloseTo(4.4);
    expect(parseTagToSizeGB("70b")).toBeCloseTo(38.5);
    expect(parseTagToSizeGB("1.7b")).toBeCloseTo(0.935);
  });

  it("handles millions of parameters", () => {
    expect(parseTagToSizeGB("270m")).toBeCloseTo(0.1485);
  });

  it("counts every expert of a mixture-of-experts tag", () => {
    expect(parseTagToSizeGB("8x7b")).toBeCloseTo(30.8);
  });

  it("treats effective-parameter tags like plain sizes", () => {
    expect(parseTagToSizeGB("e2b")).toBeCloseTo(1.1);
  });

  it("returns null for tags without a parameter count", () => {
    expect(parseTagToSizeGB("latest")).toBeNull();
    expect(parseTagToSizeGB("")).toBeNull();
  });
});

describe("estimateVramGB", () => {
  it("adds runtime overhead on top of the weights", () => {
    expect(estimateVramGB(10)).toBeCloseTo(11.5);
  });
});

describe("assessVramFit", () => {
  it("is comfortable up to 75% of VRAM", () => {
    expect(assessVramFit(18, 24)).toMatchObject({ fit: "comfortable", pct: 75 });
  });

  it("is tight between 75% and 100%", () => {
    expect(assessVramFit(20, 24).fit).toBe("tight");
    expect(assessVramFit(24, 24).fit).toBe("tight");
  });

  it("exceeds above 100%", () => {
    expect(assessVramFit(24.1, 24).fit).toBe("exceeds");
  });

  it("never fits when no VRAM is available", () => {
    expect(assessVramFit(1, 0).fit).toBe("exceeds");
  });
});

describe("vramFitColor and vramFitBg", () => {
  const fits: VramFit[] = ["comfortable", "tight", "exceeds"];

  it("maps comfortable, tight and exceeds to green, amber and red", () => {
    expect(vramFitColor("comfortable")).toContain("142");
    expect(vramFitColor("tight")).toContain("38");
    expect(vramFitColor("exceeds")).toContain("0 84%");
  });

  it("uses a translucent background in the same hue as the text color", () => {
    for (const fit of fits) {
      expect(vramFitBg(fit)).toBe(vramFitColor(fit).replace(")", " / 0.15)"));
    }
  });
});
