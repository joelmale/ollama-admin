export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { CatalogUnavailableError, getCatalog } from "@/lib/catalog";
import { logger } from "@/lib/logger";

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams.get("q")?.toLowerCase() || "";
  const capabilities = req.nextUrl.searchParams.get("c")?.toLowerCase() || "";
  const capList = capabilities
    ? capabilities.split(",").filter(Boolean)
    : [];

  try {
    let models = await getCatalog();

    if (search) {
      models = models.filter(
        (m) =>
          m.name.toLowerCase().includes(search) ||
          m.description.toLowerCase().includes(search) ||
          m.sizes.some((size) => size.includes(search))
      );
    }

    if (capList.length > 0) {
      models = models.filter((m) =>
        capList.every((c) => m.capabilities.includes(c))
      );
    }

    return NextResponse.json(models);
  } catch (error) {
    const status = error instanceof CatalogUnavailableError ? error.status : 502;
    const message =
      error instanceof CatalogUnavailableError
        ? error.message
        : "Failed to fetch models from ollama.com";
    logger.error("Catalog unavailable", { error: String(error) });
    return NextResponse.json({ error: message }, { status });
  }
}
