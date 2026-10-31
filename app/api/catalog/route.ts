export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { ProxyAgent } from "undici";

interface ScrapedModel {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: string;
  updated: string;
}

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const CONCURRENCY = 6;
const SORTS = ["popular", "newest", "name"];
const FILTERS = ["", "local", "cloud", "tools", "vision", "embedding", "thinking"];
const SEARCH_TERMS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
let cache: { data: ScrapedModel[]; timestamp: number } | null = null;

const KNOWN_CAPABILITIES = ["tools", "vision", "embedding", "thinking", "cloud", "text"];

const SIZE_RE = /^(\d+(\.\d+)?[mb]|e\d+b|\d+x\d+(\.\d+)?b)$/i;

function parseModelsFromHtml(html: string): ScrapedModel[] {
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
      if ($s.children().length > 0 || $s.closest('[title="Context window"]').length) return;
      const text = $s.text().trim().toLowerCase();
      if (KNOWN_CAPABILITIES.includes(text)) capabilities.push(text);
      else if (SIZE_RE.test(text)) sizes.push(text);
    });

    const pulls = $el.find('span[title$="downloads"] > span').first().text().trim();
    const updated = $el.find('span[title^="Updated"]').first().text().trim();

    models.push({ id, name: heading || id, description, capabilities, sizes, pulls, updated });
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
  };
  if (dispatcher) options.dispatcher = dispatcher;
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

async function scrapeAllModels(): Promise<ScrapedModel[]> {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  const modelMap = new Map<string, ScrapedModel>();

  // ollama.com/search returns at most 20 results and ignores ?page=N, so build the catalog from the
  // union of several sort/capability views plus single-character name searches.
  const queries = [
    ...SORTS.flatMap((o) => FILTERS.map((c) => `o=${o}&c=${c}`)),
    ...SEARCH_TERMS.map((q) => `o=popular&q=${q}`),
  ];

  for (let i = 0; i < queries.length; i += CONCURRENCY) {
    const batch = queries.slice(i, i + CONCURRENCY);
    const pages = await Promise.all(
      batch.map((qs) =>
        fetchPage(`https://ollama.com/search?${qs}`)
          .then(parseModelsFromHtml)
          .catch(() => [] as ScrapedModel[])
      )
    );
    for (const models of pages) {
      for (const model of models) {
        if (!modelMap.has(model.id)) {
          modelMap.set(model.id, model);
        }
      }
    }
  }

  const models = Array.from(modelMap.values()).filter((m) => {
    if (m.capabilities.length === 1 && m.capabilities[0] === "cloud") return false;
    return m.sizes.length > 0 || m.capabilities.length > 0;
  });

  for (const model of models) {
    model.capabilities = model.capabilities.filter((c) => c !== "cloud");
    if (!model.capabilities.includes("embedding")) {
      model.capabilities.unshift("text");
    }
  }

  models.sort((a, b) => {
    const parseCount = (s: string) => {
      if (!s) return 0;
      const num = parseFloat(s);
      if (s.includes("M")) return num * 1_000_000;
      if (s.includes("K")) return num * 1_000;
      return num;
    };
    return parseCount(b.pulls) - parseCount(a.pulls);
  });

  cache = { data: models, timestamp: Date.now() };
  return models;
}

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams.get("q")?.toLowerCase() || "";
  const capabilities = req.nextUrl.searchParams.get("c")?.toLowerCase() || "";
  const capList = capabilities
    ? capabilities.split(",").filter(Boolean)
    : [];

  try {
    let models = await scrapeAllModels();

    if (search) {
      models = models.filter(
        (m) =>
          m.name.toLowerCase().includes(search) ||
          m.description.toLowerCase().includes(search)
      );
    }

    if (capList.length > 0) {
      models = models.filter((m) =>
        capList.every((c) => m.capabilities.includes(c))
      );
    }

    return NextResponse.json(models);
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch models from ollama.com" },
      { status: 502 }
    );
  }
}
