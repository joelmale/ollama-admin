// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    chat: { findUnique: vi.fn(), update: vi.fn() },
    server: { findMany: vi.fn() },
    message: { create: vi.fn() },
  },
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/log-async", () => ({ logAsync: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAsync } from "@/lib/log-async";
import { POST } from "@/app/api/chats/[id]/compare/route";

const m = prisma as unknown as {
  chat: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  server: { findMany: ReturnType<typeof vi.fn> };
  message: { create: ReturnType<typeof vi.fn> };
};
const encoder = new TextEncoder();

function ndjsonResponse(...lines: object[]) {
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"));
        c.close();
      },
    })
  );
}

function post(body: object) {
  return POST(
    new Request("http://localhost/api/chats/chat_1/compare", {
      method: "POST",
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: "chat_1" }) }
  );
}

function events(text: string) {
  return text
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

const targets = [
  { serverId: "s1", model: "llama3" },
  { serverId: "s2", model: "mistral" },
];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  (checkRateLimit as ReturnType<typeof vi.fn>).mockReturnValue({ allowed: true, remaining: 10, resetMs: 0 });
  m.chat.findUnique.mockResolvedValue({
    id: "chat_1",
    title: "New Conversation",
    parameters: JSON.stringify({
      systemPrompt: "Be brief",
      temperature: 0.2,
      topK: 40,
      topP: 0.9,
      repeatPenalty: 1.1,
      seed: 7,
      numCtx: 4096,
      numPredict: 128,
      stop: "a, b",
      keepAlive: "5m",
    }),
    messages: [
      { role: "user", content: "earlier", compareGroup: null },
      { role: "assistant", content: "reply", compareGroup: null },
      { role: "assistant", content: "compare side", compareGroup: "cmp-1" },
    ],
  });
  m.server.findMany.mockResolvedValue([
    { id: "s1", name: "One", url: "http://one:11434" },
    { id: "s2", name: "Two", url: "http://two:11434" },
  ]);
  m.message.create.mockResolvedValue({});
  m.chat.update.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/chats/[id]/compare", () => {
  it("streams both sides, saves each reply and finishes", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      ndjsonResponse({ message: { content: "hi" } }, { done: true, prompt_eval_count: 4, eval_count: 2 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await post({ content: "question", targets });
    const evts = events(await res.text());

    expect(evts.filter((e) => e.done).map((e) => e.model).sort()).toEqual(["llama3", "mistral"]);
    expect(evts.at(-1)).toEqual({ allDone: true });
    expect(m.message.create).toHaveBeenCalledTimes(3);
    expect(m.chat.update).toHaveBeenCalledWith({ where: { id: "chat_1" }, data: { title: "question" } });
    expect(logAsync).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/api/chat/compare", promptTokens: 4 }));

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.messages.map((x: { content: string }) => x.content)).toEqual(["Be brief", "earlier", "reply", "question"]);
    expect(sent.options).toEqual({
      temperature: 0.2,
      top_k: 40,
      top_p: 0.9,
      repeat_penalty: 1.1,
      seed: 7,
      num_ctx: 4096,
      num_predict: 128,
      stop: ["a", "b"],
    });
    expect(sent.keep_alive).toBe("5m");
  });

  it("reports a side that cannot connect without failing the other", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("two")) throw new Error("ECONNREFUSED");
        return ndjsonResponse({ message: { content: "ok" } }, { done: true });
      })
    );

    const evts = events(await (await post({ content: "q", targets })).text());

    expect(evts).toContainEqual({ side: "1", error: "Error: Connection failed" });
    expect(evts.some((e) => e.side === "0" && e.done)).toBe(true);
  });

  it.each([
    [{ content: "", targets }],
    [{ content: "q", targets: [] }],
    [{ content: "q", targets: [...targets, ...targets] }],
  ])("rejects invalid input %#", async (body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
  });

  it("returns 404 for a missing chat", async () => {
    m.chat.findUnique.mockResolvedValue(null);

    expect((await post({ content: "q", targets })).status).toBe(404);
  });

  it("returns 404 for an inactive or unknown server", async () => {
    m.server.findMany.mockResolvedValue([{ id: "s1", name: "One", url: "http://one:11434" }]);

    const res = await post({ content: "q", targets });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("s2");
  });

  it("returns 429 when rate limited", async () => {
    (checkRateLimit as ReturnType<typeof vi.fn>).mockReturnValue({ allowed: false, remaining: 0, resetMs: 5000 });

    const res = await post({ content: "q", targets });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
  });
});
