import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

describe("PullManager", () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).pullManager = undefined;
  });

  async function loadPullManager() {
    const mod = await import("../pull-manager");
    return mod.pullManager;
  }

  it("returns a pulling job on startPull", async () => {
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"pulling"}\n'));
        controller.close();
      },
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      body: mockStream,
    }));

    const pm = await loadPullManager();
    const job = pm.startPull("srv1", "http://localhost:11434", "llama3:8b");

    expect(job.status).toBe("pulling");
    expect(job.model).toBe("llama3");
    expect(job.tag).toBe("8b");
    expect(job.serverId).toBe("srv1");
    expect(job.id).toBe("srv1:llama3:8b");
  });

  it("parses model without tag as latest", async () => {
    const mockStream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      body: mockStream,
    }));

    const pm = await loadPullManager();
    const job = pm.startPull("srv1", "http://localhost:11434", "llama3");

    expect(job.model).toBe("llama3");
    expect(job.tag).toBe("latest");
  });

  it("returns existing job if already pulling", async () => {
    const mockStream = new ReadableStream({ start() {} });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      body: mockStream,
    }));

    const pm = await loadPullManager();
    const job1 = pm.startPull("srv1", "http://localhost:11434", "llama3:8b");
    const job2 = pm.startPull("srv1", "http://localhost:11434", "llama3:8b");

    expect(job1).toBe(job2);
  });

  it("filters jobs by serverId", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        body: new ReadableStream({ start() {} }),
      });
    }));

    const pm = await loadPullManager();
    pm.startPull("srv1", "http://localhost:11434", "llama3:8b");
    pm.startPull("srv2", "http://other:11434", "mistral:7b");

    expect(pm.getStatus("srv1")).toHaveLength(1);
    expect(pm.getStatus("srv2")).toHaveLength(1);
    expect(pm.getStatus()).toHaveLength(2);
    expect(callCount).toBe(2);
  });

  it("sets error status on fetch failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      body: null,
    });
    vi.stubGlobal("fetch", fetchMock);

    const pm = await loadPullManager();
    const job = pm.startPull("srv1", "http://localhost:11434", "llama3:8b");
    // Wait for the internal pull promise to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(job.status).toBe("error");
    expect(job.error).toContain("500");
  });

  it("updates progress from stream and completes", async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"total":1000,"completed":500}\n'));
          controller.enqueue(new TextEncoder().encode('{"total":1000,"completed":1000}\n'));
          controller.enqueue(new TextEncoder().encode('{"status":"success"}\n'));
          controller.close();
        },
      });
      return Promise.resolve({ ok: true, body: stream });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pm = await loadPullManager();
    const job = pm.startPull("srv1", "http://localhost:11434", "llama3:8b");
    // Wait for the internal pull promise to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(job.status).toBe("done");
    expect(job.progress).toBe(100);
  });
});

describe("PullManager failure handling", () => {
  const encoder = new TextEncoder();

  beforeEach(() => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).pullManager = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function load() {
    return import("../pull-manager");
  }

  function respondWith(lines: string[]) {
    return vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            for (const l of lines) controller.enqueue(encoder.encode(l + "\n"));
            controller.close();
          },
        }),
      })
    );
  }

  function hangUntilAborted() {
    return vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('{"status":"pulling manifest"}\n'));
            init.signal!.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError"))
            );
          },
        }),
      })
    );
  }

  it("fails a pull whose stream ends without Ollama reporting success", async () => {
    vi.stubGlobal("fetch", respondWith(['{"total":1000,"completed":400}']));
    const { pullManager } = await load();

    const job = pullManager.startPull("srv1", "http://localhost:11434", "llama3:8b");
    await vi.waitFor(() => expect(job.status).toBe("error"));

    expect(job.error).toContain("before the pull finished");
    expect(job.progress).toBe(40);
  });

  it("reports progress from a completed count of 0", async () => {
    vi.stubGlobal("fetch", respondWith(['{"total":1000,"completed":0}', '{"status":"success"}']));
    const { pullManager } = await load();

    const job = pullManager.startPull("srv1", "http://localhost:11434", "llama3:8b");
    await vi.waitFor(() => expect(job.status).toBe("done"));
  });

  it("stops a pull that makes no progress and lets it be retried", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = hangUntilAborted();
    vi.stubGlobal("fetch", fetchMock);
    const { pullManager, PULL_IDLE_TIMEOUT_MS } = await load();

    const job = pullManager.startPull("srv1", "http://localhost:11434", "llama3:8b");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(PULL_IDLE_TIMEOUT_MS + 1000);
    await vi.waitFor(() => expect(job.status).toBe("error"));
    expect(job.error).toContain("No progress");

    const retry = pullManager.startPull("srv1", "http://localhost:11434", "llama3:8b");
    expect(retry).not.toBe(job);
    expect(retry.status).toBe("pulling");
  });

  it("replaces a job that has gone stale instead of returning it forever", async () => {
    const fetchMock = hangUntilAborted();
    vi.stubGlobal("fetch", fetchMock);
    const { pullManager, PULL_IDLE_TIMEOUT_MS } = await load();

    const first = pullManager.startPull("srv1", "http://localhost:11434", "llama3:8b");
    first.lastActivityAt = Date.now() - PULL_IDLE_TIMEOUT_MS - 1;

    const second = pullManager.startPull("srv1", "http://localhost:11434", "llama3:8b");

    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(pullManager.getStatus("srv1")).toEqual([second]);
  });
});
