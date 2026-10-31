// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    chat: { findUnique: vi.fn(), update: vi.fn() },
    message: { create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, remaining: 59, resetMs: 1000 })),
  getRateLimitConfig: vi.fn(() => ({ maxRequests: 60, windowMs: 60_000 })),
}));
vi.mock("@/lib/log-async", () => ({ logAsync: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { logAsync } from "@/lib/log-async";
import { POST } from "@/app/api/chats/[id]/messages/route";

const mocked = prisma as unknown as {
  chat: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  message: {
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

const encoder = new TextEncoder();

function msg(id: string, role: string, content: string) {
  return { id, role, content, images: null };
}

function givenChat(messages: ReturnType<typeof msg>[], title = "Existing") {
  mocked.chat.findUnique.mockResolvedValue({
    id: "chat_1",
    title,
    model: "llama3",
    parameters: null,
    messages,
    server: { id: "srv_1", name: "Local", url: "http://ollama:11434" },
  });
}

function ndjson(...lines: object[]) {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function streamResponse(chunks: string[], opts: { failAfter?: boolean } = {}) {
  const queue = [...chunks];
  return new Response(
    new ReadableStream({
      pull(controller) {
        const next = queue.shift();
        if (next !== undefined) controller.enqueue(encoder.encode(next));
        else if (opts.failAfter) controller.error(new TypeError("terminated"));
        else controller.close();
      },
    }),
    { status: 200 }
  );
}

function post(body: object) {
  return POST(
    new Request("http://localhost/api/chats/chat_1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: "chat_1" }) }
  );
}

function assistantSaves() {
  return mocked.message.create.mock.calls
    .map(([arg]) => arg.data)
    .filter((d: { role: string }) => d.role === "assistant");
}

function sentMessages(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetchMock.mock.calls[0][1].body).messages.map(
    (m: { role: string; content: string }) => `${m.role}:${m.content}`
  );
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocked.message.create.mockResolvedValue({});
  mocked.chat.update.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("regenerate", () => {
  it("keeps earlier answers when the last reply failed", async () => {
    givenChat([msg("u1", "user", "first"), msg("a1", "assistant", "answer"), msg("u2", "user", "second")]);
    const fetchMock = vi.fn().mockResolvedValue(
      streamResponse([ndjson({ message: { content: "new" } }, { done: true })])
    );
    vi.stubGlobal("fetch", fetchMock);

    await (await post({ regenerate: true })).text();

    expect(mocked.message.delete).not.toHaveBeenCalled();
    expect(sentMessages(fetchMock)).toEqual(["user:first", "assistant:answer", "user:second"]);
  });

  it("replaces the final reply", async () => {
    givenChat([msg("u1", "user", "first"), msg("a1", "assistant", "answer")]);
    const fetchMock = vi.fn().mockResolvedValue(
      streamResponse([ndjson({ message: { content: "again" } }, { done: true })])
    );
    vi.stubGlobal("fetch", fetchMock);

    await (await post({ regenerate: true })).text();

    expect(mocked.message.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
    expect(sentMessages(fetchMock)).toEqual(["user:first"]);
  });

  it("rejects a regenerate with no user message", async () => {
    givenChat([]);
    vi.stubGlobal("fetch", vi.fn());

    const res = await post({ regenerate: true });

    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("edit", () => {
  it("drops the edited message and everything after it, then resends", async () => {
    givenChat([
      msg("u1", "user", "first"),
      msg("a1", "assistant", "answer"),
      msg("u2", "user", "second"),
      msg("a2", "assistant", "later"),
    ]);
    const deleteMany = (prisma as unknown as { message: { deleteMany: ReturnType<typeof vi.fn> } }).message.deleteMany;
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([ndjson({ message: { content: "x" } }, { done: true })]));
    vi.stubGlobal("fetch", fetchMock);

    await (await post({ content: "second, edited", editMessageId: "u2" })).text();

    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["u2", "a2"] } } });
    expect(sentMessages(fetchMock)).toEqual(["user:first", "assistant:answer", "user:second, edited"]);
  });
});

it("returns 404 for a missing chat", async () => {
  mocked.chat.findUnique.mockResolvedValue(null);

  expect((await post({ content: "hi" })).status).toBe(404);
});

describe("streaming", () => {
  it("saves the reply and sends a done event", async () => {
    givenChat([], "New Conversation");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        streamResponse([
          ndjson({ message: { content: "Hel" } }),
          ndjson({ message: { content: "lo" } }, { done: true, prompt_eval_count: 3, eval_count: 2 }),
        ])
      )
    );

    const text = await (await post({ content: "hi" })).text();

    expect(assistantSaves()).toEqual([
      expect.objectContaining({ content: "Hello", promptTokens: 3, completionTokens: 2 }),
    ]);
    expect(text).toContain('"done":true');
    expect(mocked.chat.update).toHaveBeenCalledWith({ where: { id: "chat_1" }, data: { title: "hi" } });
    expect(logAsync).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 200 }));
  });

  it("keeps the partial reply and reports an error line from Ollama", async () => {
    givenChat([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        streamResponse([ndjson({ message: { content: "partial" } }, { error: "model ran out of memory" })])
      )
    );

    const text = await (await post({ content: "hi" })).text();

    expect(assistantSaves()).toEqual([expect.objectContaining({ content: "partial" })]);
    expect(text).toContain('"error":"model ran out of memory"');
    expect(text).not.toContain('"done":true');
    expect(logAsync).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 502 }));
  });

  it("keeps the partial reply when Ollama drops the connection", async () => {
    givenChat([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        streamResponse([ndjson({ message: { content: "half" } })], { failAfter: true })
      )
    );

    const text = await (await post({ content: "hi" })).text();

    expect(assistantSaves()).toEqual([expect.objectContaining({ content: "half" })]);
    expect(text).toContain('"error"');
  });

  it("does not save an empty reply", async () => {
    givenChat([]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse([ndjson({ error: "boom" })])));

    await (await post({ content: "hi" })).text();

    expect(assistantSaves()).toEqual([]);
  });

  it("reports a failure to save instead of hanging", async () => {
    givenChat([]);
    mocked.message.create.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("SQLITE_BUSY"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(streamResponse([ndjson({ message: { content: "x" } }, { done: true })]))
    );

    const text = await (await post({ content: "hi" })).text();

    expect(text).toContain("could not be saved");
  });

  it("aborts the upstream request and keeps the partial reply when the client disconnects", async () => {
    givenChat([]);
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        upstreamSignal = init.signal!;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(ndjson({ message: { content: "so far" } })));
              init.signal!.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
            },
          })
        );
      })
    );

    const res = await post({ content: "hi" });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    await vi.waitFor(() => expect(assistantSaves()).toHaveLength(1));
    expect(upstreamSignal?.aborted).toBe(true);
    expect(assistantSaves()[0].content).toBe("so far");
    expect(logAsync).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 499 }));
  });

  it("surfaces Ollama's error body when the request is rejected", async () => {
    givenChat([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'model "nope" not found, try pulling it first' }), {
          status: 404,
          statusText: "Not Found",
        })
      )
    );

    const res = await post({ content: "hi" });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('model "nope" not found');
  });
});