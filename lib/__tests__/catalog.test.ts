// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CatalogUnavailableError,
  getCatalog,
  parseModelsFromHtml,
  resetCatalogCache,
  scrapeCatalog,
} from "@/lib/catalog";

const fixture = readFileSync(resolve(__dirname, "fixtures/ollama-search.html"), "utf8");

beforeEach(() => {
  resetCatalogCache();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("parseModelsFromHtml", () => {
  it("reads current ollama.com markup", () => {
    const models = parseModelsFromHtml(fixture);

    expect(models.map((m) => m.id)).toEqual(["llama3.1", "llama3.2-vision", "glm-5.3"]);
    expect(models[0]).toMatchObject({
      capabilities: ["tools"],
      sizes: ["8b", "70b", "405b"],
      pulls: "120.7M",
    });
    expect(models[0].description).toContain("Meta");
    expect(models[1].capabilities).toEqual(["vision"]);
    expect(models[2].capabilities).toContain("cloud");
  });

  it("does not mistake the download count for a model size", () => {
    const [llama] = parseModelsFromHtml(fixture);

    expect(llama.sizes).not.toContain("120.7m");
  });

  it("returns nothing for markup it does not recognise", () => {
    expect(parseModelsFromHtml("<html><body><div>Redesigned!</div></body></html>")).toEqual([]);
  });
});

describe("scrapeCatalog", () => {
  it("merges pages, strips the cloud badge and sorts by downloads", async () => {
    const models = await scrapeCatalog(async () => fixture);

    expect(models.map((m) => m.id)).toEqual(["llama3.1", "llama3.2-vision", "glm-5.3"]);
    expect(models[0].capabilities).toEqual(["text", "tools"]);
    expect(models[2].capabilities).toEqual(["text", "tools", "thinking"]);
  });

  it("drops models whose only capability is cloud", async () => {
    const cloudOnly = '<a href="/library/remote"><h2>remote</h2><span>cloud</span></a>';
    const models = await scrapeCatalog(async () => fixture + cloudOnly);

    expect(models.map((m) => m.id)).not.toContain("remote");
  });

  it("fails loudly when every request fails", async () => {
    await expect(
      scrapeCatalog(async () => {
        throw new Error("getaddrinfo ENOTFOUND ollama.com");
      })
    ).rejects.toThrow(/every request to ollama.com failed.*ENOTFOUND/);
  });

  it("fails loudly when the markup changes", async () => {
    await expect(scrapeCatalog(async () => "<html></html>")).rejects.toThrow(/changed its layout/);
  });

  it("tolerates some failed pages", async () => {
    let n = 0;
    const models = await scrapeCatalog(async () => {
      n++;
      if (n % 2) throw new Error("503");
      return fixture;
    });

    expect(models).toHaveLength(3);
  });
});

describe("getCatalog", () => {
  it("does not cache a failure", async () => {
    const failing = vi.fn(async () => "<html></html>");
    await expect(getCatalog(failing, true)).rejects.toBeInstanceOf(CatalogUnavailableError);

    const models = await getCatalog(async () => fixture, true);
    expect(models).toHaveLength(3);
  });

  it("shares one scrape between concurrent requests", async () => {
    const fetcher = vi.fn(async () => fixture);

    await Promise.all([getCatalog(fetcher, true), getCatalog(fetcher, true), getCatalog(fetcher, true)]);
    const firstRun = fetcher.mock.calls.length;
    await getCatalog(fetcher, true);

    expect(firstRun).toBe(57);
    expect(fetcher).toHaveBeenCalledTimes(57);
  });

  it("returns 503 when refresh is disabled and nothing is cached", async () => {
    const err = await getCatalog(vi.fn(), false).catch((e) => e);

    expect(err).toBeInstanceOf(CatalogUnavailableError);
    expect(err.status).toBe(503);
  });

  it("serves the stale cache when ollama.com becomes unreachable", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await getCatalog(async () => fixture, true);
      vi.advanceTimersByTime(31 * 60 * 1000);

      const models = await getCatalog(async () => {
        throw new Error("offline");
      }, true);

      expect(models).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
