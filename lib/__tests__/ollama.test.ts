import { afterEach, describe, it, expect, vi } from "vitest";
import {
  buildOllamaUrl,
  formatOllamaConnectionError,
  normalizeOllamaUrl,
  ollamaFetch,
  redactOllamaUrl,
  resolveOllamaUrl,
} from "@/lib/ollama";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ollamaFetch", () => {
  it("calls the correct URL and returns JSON", async () => {
    const mockResponse = { version: "0.3.0" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const result = await ollamaFetch("http://localhost:11434", "/api/version");
    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/version",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      })
    );
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }));

    await expect(
      ollamaFetch("http://localhost:11434", "/api/version")
    ).rejects.toThrow("Ollama API error: 500 Internal Server Error");
  });

  it("strips trailing slash from base URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }));

    await ollamaFetch("http://localhost:11434/", "/api/tags");
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.anything()
    );
  });

  it("reaches the Docker host when a saved server uses localhost", async () => {
    vi.stubEnv(
      "DEFAULT_OLLAMA_URL",
      "http://host.docker.internal:11434"
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: "0.11.0" }),
    }));

    await ollamaFetch("http://localhost:11439", "/api/version");

    expect(fetch).toHaveBeenCalledWith(
      "http://host.docker.internal:11439/api/version",
      expect.anything()
    );
  });
});

describe("resolveOllamaUrl", () => {
  it.each([
    "http://localhost:11439/base",
    "http://localhost.:11439/base",
    "http://127.42.0.1:11439/base",
    "http://[::1]:11439/base",
  ])("maps loopback host %s to the configured Docker host", (url) => {
    vi.stubEnv(
      "DEFAULT_OLLAMA_URL",
      "http://host.docker.internal:11434"
    );

    expect(resolveOllamaUrl(url)).toBe(
      "http://host.docker.internal:11439/base"
    );
  });

  it("leaves localhost unchanged outside the Docker host configuration", () => {
    vi.stubEnv("DEFAULT_OLLAMA_URL", "http://localhost:11434");

    expect(resolveOllamaUrl("http://localhost:11439")).toBe(
      "http://localhost:11439"
    );
  });

  it("never rewrites a non-loopback server", () => {
    vi.stubEnv(
      "DEFAULT_OLLAMA_URL",
      "http://host.docker.internal:11434"
    );

    expect(resolveOllamaUrl("https://ollama.example.com:11439")).toBe(
      "https://ollama.example.com:11439"
    );
  });
});

describe("formatOllamaConnectionError", () => {
  it("explains that localhost points to the container", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });

    expect(
      formatOllamaConnectionError("http://localhost:11434", error)
    ).toContain("localhost points to the Ollama Admin container");
  });

  it("explains how to map host.docker.internal when DNS fails", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ENOTFOUND" },
    });

    const message = formatOllamaConnectionError(
      "http://host.docker.internal:11434",
      error
    );
    expect(message).toContain("host.docker.internal:host-gateway");
    expect(message).toContain("extra_hosts");
  });

  it("explains how to expose Ollama when the host refuses the connection", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: {
        errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }],
      },
    });

    expect(
      formatOllamaConnectionError(
        "http://host.docker.internal:11434",
        error
      )
    ).toContain("OLLAMA_HOST=0.0.0.0:11434");
  });

  it("reports the effective Docker target for a rewritten localhost failure", () => {
    vi.stubEnv(
      "DEFAULT_OLLAMA_URL",
      "http://host.docker.internal:11434"
    );
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });

    const message = formatOllamaConnectionError(
      "http://localhost:11439",
      error
    );

    expect(message).toContain("http://host.docker.internal:11439");
    expect(message).toContain("OLLAMA_HOST=0.0.0.0:11434");
  });

  it("preserves an HTTP error returned by Ollama", () => {
    expect(
      formatOllamaConnectionError(
        "http://host.docker.internal:11434",
        new Error("Ollama API error: 503 Service Unavailable")
      )
    ).toBe("Ollama API error: 503 Service Unavailable");
  });

  it.each([
    "http://[::1]:11434",
    "http://localhost.:11434",
    "http://127.42.0.1:11434",
  ])("recognizes loopback host %s", (url) => {
    expect(
      formatOllamaConnectionError(url, new TypeError("fetch failed"))
    ).toContain("localhost points to the Ollama Admin container");
  });
});

describe("normalizeOllamaUrl", () => {
  it("trims input and removes only the trailing slash", () => {
    expect(normalizeOllamaUrl("  http://ollama.internal:11434/base/  ")).toBe(
      "http://ollama.internal:11434/base"
    );
  });

  it.each([
    ["", "URL is required"],
    [42, "URL is required"],
    ["ftp://ollama.internal", "must use http or https"],
    ["http://alice:secret@ollama.internal", "must not include embedded credentials"],
    ["http://ollama.internal/#fragment", "must not include"],
    ["http://ollama.internal/?target=other", "must not include"],
  ])("rejects invalid value %j", (value, error) => {
    expect(() => normalizeOllamaUrl(value)).toThrow(error as string);
  });
});

describe("redactOllamaUrl", () => {
  it("removes credentials, query strings, and fragments", () => {
    expect(
      redactOllamaUrl(
        "http://alice:secret@ollama.internal:11434/base?token=secret#part"
      )
    ).toBe("http://ollama.internal:11434/base");
  });

  it("does not echo invalid values", () => {
    expect(redactOllamaUrl("secret-not-a-url")).toBe("[invalid Ollama URL]");
  });
});

describe("buildOllamaUrl", () => {
  it("builds an API URL from a validated base", () => {
    expect(buildOllamaUrl("http://ollama.internal:11434/", "/api/version")).toBe(
      "http://ollama.internal:11434/api/version"
    );
  });

  it("rejects a legacy credential-bearing base before fetch", () => {
    expect(() =>
      buildOllamaUrl("http://alice:secret@ollama.internal:11434", "/api/chat")
    ).toThrow("must not include embedded credentials");
  });
});

describe("request timeouts", () => {
  it("gives ollamaFetch a default timeout signal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));

    await ollamaFetch("http://localhost:11434", "/api/version");

    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("explains a timeout instead of a generic connection failure", () => {
    const message = formatOllamaConnectionError(
      "http://gpu-box:11434",
      new DOMException("The operation was aborted due to timeout", "TimeoutError")
    );

    expect(message).toContain("did not respond in time");
  });
});
