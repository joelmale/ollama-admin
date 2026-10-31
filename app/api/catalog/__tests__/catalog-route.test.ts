// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/catalog")>()),
  getCatalog: vi.fn(),
}));

import { CatalogUnavailableError, getCatalog } from "@/lib/catalog";
import { GET } from "@/app/api/catalog/route";

const models = [
  { id: "llama3.1", name: "llama3.1", description: "Meta model", capabilities: ["text", "tools"], sizes: ["8b"], pulls: "1M", updated: "1y" },
  { id: "nomic", name: "nomic-embed", description: "Embeddings", capabilities: ["embedding"], sizes: ["137m"], pulls: "2M", updated: "1y" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/catalog", () => {
  it("filters by search and capability", async () => {
    (getCatalog as ReturnType<typeof vi.fn>).mockResolvedValue(models);

    const res = await GET(new NextRequest("http://localhost/api/catalog?q=meta&c=tools"));

    expect((await res.json()).map((m: { id: string }) => m.id)).toEqual(["llama3.1"]);
  });

  it("returns the catalog error and status instead of an empty list", async () => {
    (getCatalog as ReturnType<typeof vi.fn>).mockRejectedValue(
      new CatalogUnavailableError("Could not load the model catalog: layout changed.")
    );

    const res = await GET(new NextRequest("http://localhost/api/catalog"));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("layout changed");
  });

  it("returns 503 when the catalog is disabled", async () => {
    (getCatalog as ReturnType<typeof vi.fn>).mockRejectedValue(
      new CatalogUnavailableError("disabled", 503)
    );

    const res = await GET(new NextRequest("http://localhost/api/catalog"));

    expect(res.status).toBe(503);
  });
});
