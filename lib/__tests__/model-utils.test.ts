import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OllamaModel } from "@/lib/ollama";
import { gradeBg, gradeColor, scoreModel, type Grade } from "@/lib/model-scoring";

function model(name: string, families?: string[]): OllamaModel {
  return { name, details: families ? { families } : undefined } as unknown as OllamaModel;
}

describe("model-utils", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies by name and family without the catalog", async () => {
    const { isChatModel, isEmbeddingModel, isOcrModel, isVisionModel } = await import("@/lib/model-utils");

    expect(isEmbeddingModel(model("nomic-embed-text:latest"))).toBe(true);
    expect(isEmbeddingModel(model("all-minilm", ["bert"]))).toBe(true);
    expect(isEmbeddingModel(model("llama3", ["llama"]))).toBe(false);
    expect(isEmbeddingModel(model("llama3", []))).toBe(false);
    expect(isVisionModel(model("llava", ["llama", "clip"]))).toBe(true);
    expect(isVisionModel(model("llama3", ["llama"]))).toBe(false);
    expect(isOcrModel(model("deepseek-ocr:3b"))).toBe(true);
    expect(isChatModel(model("llama3", ["llama"]))).toBe(true);
    expect(isChatModel(model("deepseek-ocr"))).toBe(false);
  });

  it("uses catalog capabilities once loaded, fetching only once", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "gemma3", capabilities: ["vision", "text"] },
        { id: "mxbai", capabilities: ["embedding"] },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const { isEmbeddingModel, isVisionModel, loadCatalogCapabilities } = await import("@/lib/model-utils");

    await Promise.all([loadCatalogCapabilities(), loadCatalogCapabilities()]);
    await loadCatalogCapabilities();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isVisionModel(model("gemma3:12b"))).toBe(true);
    expect(isEmbeddingModel(model("MXBAI:latest"))).toBe(true);
  });

  it("falls back to heuristics when the catalog is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const { isVisionModel, loadCatalogCapabilities } = await import("@/lib/model-utils");

    await loadCatalogCapabilities();

    expect(isVisionModel(model("gemma3"))).toBe(false);
  });

  it("survives a network error loading the catalog", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { isVisionModel, loadCatalogCapabilities } = await import("@/lib/model-utils");

    await expect(loadCatalogCapabilities()).resolves.toBeUndefined();
    expect(isVisionModel(model("gemma3"))).toBe(false);
  });
});

describe("model-scoring", () => {
  it.each([
    [1, 24, 1000, "S"],
    [20, 24, 800, "A"],
    [20, 24, 400, "B"],
    [20, 24, 200, "C"],
    [20, 24, 100, "D"],
    [20, 24, 50, "F"],
  ] as const)("grades %sGB on %sGB VRAM at %s GB/s as %s", (size, vram, bw, grade) => {
    expect(scoreModel(size, vram, bw).grade).toBe(grade);
  });

  it("marks a model that does not fit as F", () => {
    expect(scoreModel(30, 24, 1000)).toMatchObject({ fits: false, grade: "F", tps: 0 });
  });

  it("gives a neutral C when bandwidth is unknown", () => {
    expect(scoreModel(8, 24, undefined)).toMatchObject({ fits: true, grade: "C", hasBandwidth: false });
  });

  it("caps memory percentage and handles zero VRAM", () => {
    expect(scoreModel(100, 1, 100).memPct).toBe(999);
    expect(scoreModel(1, 0, 100).memPct).toBe(0);
  });

  it("has a colour and background for every grade", () => {
    for (const g of ["S", "A", "B", "C", "D", "F"] as Grade[]) {
      expect(gradeColor(g)).toMatch(/^hsl\(/);
      expect(gradeBg(g)).toMatch(/^hsl\(/);
    }
  });
});
