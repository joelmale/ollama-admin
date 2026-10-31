import * as cheerio from "cheerio";
import { ProxyAgent } from "undici";
import { logger } from "@/lib/logger";
import { CATALOG_REFRESH_ENABLED } from "@/lib/constants";

export interface ScrapedModel {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: string;
  pullCount: number;
  updated: string;
  updatedAt: string;
}

export class CatalogUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: 502 | 503 = 502
  ) {
    super(message);
  }
}

const CACHE_TTL = 30 * 60 * 1000;
const CONCURRENCY = 6;
const PAGE_TIMEOUT_MS = 10_000;
const SORTS = ["popular", "newest", "name"];
const FILTERS = ["", "local", "cloud", "tools", "vision", "embedding", "thinking"];
const SEARCH_TERMS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const KNOWN_CAPABILITIES = new Set(["tools", "vision", "embedding", "thinking", "cloud", "text"]);
// Parameter counts ("8b", "270m"), effective sizes ("e4b") and mixtures ("8x7b").
const SIZE_PATTERNS = [/^\d+(\.\d+)?[mb]$/i, /^e\d+b$/i, /^\d+x\d+(\.\d+)?b$/i];

function isSizeLabel(text: string) {
  return SIZE_PATTERNS.some((re) => re.test(text));
}

export function parseModelsFromHtml(html: string): ScrapedModel[] {
  const $ = cheerio.load(html);
  const models: ScrapedModel[] = [];

  $('a[href^="/library/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href") || "";
    const id = href.replace("/library/", "");
    if (!id || id.includes("/")) return;

    const heading = $el.find("h2").first().text().trim();
    const description = $el.find("p").first().text().trim();

    const capabilities: string[] = [];
    const sizes: string[] = [];

    // ollama.com no longer ships x-test-* attributes, so classify leaf badge spans by their text.
    $el.find("span").each((_, span) => {
      const $s = $(span);
      // Download counts ("120.7M") would otherwise match the size pattern.
      if (
        $s.children().length > 0 ||
        $s.closest('[title="Context window"]').length ||
        $s.closest('[title$="downloads"]').length
      ) return;
      const text = $s.text().trim().toLowerCase();
      if (KNOWN_CAPABILITIES.has(text)) capabilities.push(text);
      else if (isSizeLabel(text)) sizes.push(text);
    });

    const pulls = $el.find('span[title$="downloads"] > span').first().text().trim();
    const exactDownloads = Number(($el.find('span[title$="downloads"]').first().attr("title") ?? "").replace(/\D/g, ""));
    const pullCount = exactDownloads || parseCount(pulls);
    const $updated = $el.find('span[title^="Updated"]').first();
    const updated = $updated.text().trim();
    const updatedTime = Date.parse(($updated.attr("title") ?? "").replace(/^Updated\s+/, ""));
    const updatedAt = Number.isNaN(updatedTime) ? "" : new Date(updatedTime).toISOString();

    models.push({ id, name: heading || id, description, capabilities, sizes, pulls, pullCount, updated, updatedAt });
  });

  return models;
}

function getProxyDispatcher(): ProxyAgent | undefined {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (!proxyUrl) return undefined;
  return new ProxyAgent(proxyUrl);
}

async function fetchPage(url: string): Promise<string> {
  const dispatcher = getProxyDispatcher();
  const options: RequestInit & { dispatcher?: ProxyAgent } = {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  };
  if (dispatcher) options.dispatcher = dispatcher;
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

function parseCount(s: string) {
  if (!s) return 0;
  const num = Number.parseFloat(s);
  if (s.includes("M")) return num * 1_000_000;
  if (s.includes("K")) return num * 1_000;
  return num;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    const i = next++;
    if (i >= items.length) return;
    results[i] = await fn(items[i]);
    return worker();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function isListable(m: ScrapedModel) {
  if (m.capabilities.length === 1 && m.capabilities[0] === "cloud") return false;
  return m.sizes.length > 0 || m.capabilities.length > 0;
}

function firstSeenById(pages: ScrapedModel[][]) {
  const modelMap = new Map<string, ScrapedModel>();
  for (const model of pages.flat()) {
    if (!modelMap.has(model.id)) modelMap.set(model.id, model);
  }
  return Array.from(modelMap.values());
}

export async function scrapeCatalog(fetcher: (url: string) => Promise<string> = fetchPage): Promise<ScrapedModel[]> {
  // ollama.com/search returns at most 20 results and ignores ?page=N, so build the catalog from the
  // union of several sort/capability views plus single-character name searches.
  const queries = [
    ...SORTS.flatMap((o) => FILTERS.map((c) => `o=${o}&c=${c}`)),
    ...SEARCH_TERMS.map((q) => `o=popular&q=${q}`),
  ];

  let failedPages = 0;
  let lastError = "";
  const pages = await mapWithConcurrency(queries, CONCURRENCY, async (qs) => {
    try {
      return parseModelsFromHtml(await fetcher(`https://ollama.com/search?${qs}`));
    } catch (error) {
      failedPages++;
      lastError = error instanceof Error ? error.message : String(error);
      return [] as ScrapedModel[];
    }
  });

  const models = firstSeenById(pages).filter(isListable);

  if (models.length === 0) {
    const reason =
      failedPages === queries.length
        ? `every request to ollama.com failed (${lastError})`
        : "no models could be read from the page; ollama.com may have changed its layout";
    throw new CatalogUnavailableError(`Could not load the model catalog: ${reason}.`);
  }
  if (failedPages > 0) {
    logger.warn("Catalog scrape partially failed", { failedPages, total: queries.length, lastError });
  }

  for (const model of models) {
    model.capabilities = model.capabilities.filter((c) => c !== "cloud");
    if (!model.capabilities.includes("embedding")) {
      model.capabilities.unshift("text");
    }
  }

  models.sort((a, b) => b.pullCount - a.pullCount);
  return models;
}

let cache: { data: ScrapedModel[]; timestamp: number } | null = null;
let inFlight: Promise<ScrapedModel[]> | null = null;

/**
 * Serves a fresh cache, shares one scrape between concurrent callers, and falls
 * back to a stale cache when ollama.com is unreachable. Failures are not cached.
 */
export async function getCatalog(
  fetcher?: (url: string) => Promise<string>,
  refreshEnabled = CATALOG_REFRESH_ENABLED
): Promise<ScrapedModel[]> {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) return cache.data;

  if (!refreshEnabled) {
    if (cache) return cache.data;
    throw new CatalogUnavailableError(
      "The model catalog is disabled on this server (CATALOG_REFRESH_ENABLED=false).",
      503
    );
  }

  inFlight ??= scrapeCatalog(fetcher)
    .then((data) => {
      cache = { data, timestamp: Date.now() };
      return data;
    })
    .finally(() => {
      inFlight = null;
    });

  try {
    return await inFlight;
  } catch (error) {
    if (cache) {
      logger.warn("Serving stale catalog", { error: String(error) });
      return cache.data;
    }
    throw error;
  }
}

export function resetCatalogCache() {
  cache = null;
  inFlight = null;
}
