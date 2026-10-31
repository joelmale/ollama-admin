import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { getRateLimitKey } from "@/lib/with-rate-limit";
import { logger } from "@/lib/logger";
import {
  buildOllamaUrl,
  formatOllamaConnectionError,
  readOllamaError,
} from "@/lib/ollama";
import { logAsync } from "@/lib/log-async";

interface ModelTarget {
  serverId: string;
  model: string;
}

interface SideRequest {
  target: ModelTarget;
  server: { id: string; url: string };
  res: Response | null;
  error: string | null;
}

const CLIENT_CLOSED_REQUEST = 499;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rlKey = getRateLimitKey(req);
  const rl = checkRateLimit(rlKey);
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: "Too many requests. Please try again later." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(rl.resetMs / 1000)),
        },
      }
    );
  }

  const { content, targets } = (await req.json()) as {
    content: string;
    targets: ModelTarget[];
  };

  if (!content?.trim() || !targets?.length || targets.length > 3) {
    return new Response(
      JSON.stringify({ error: "content and 1-3 targets required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const chat = await prisma.chat.findUnique({
    where: { id: id },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!chat) {
    return new Response(JSON.stringify({ error: "Chat not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const serverIds = Array.from(new Set(targets.map((t) => t.serverId)));
  const servers = await prisma.server.findMany({
    where: { id: { in: serverIds }, active: true },
  });
  const serverMap = new Map(servers.map((s) => [s.id, s]));

  for (const t of targets) {
    if (!serverMap.has(t.serverId)) {
      return new Response(
        JSON.stringify({ error: `Server ${t.serverId} not found` }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // Save user message
  const compareGroup = `cmp-${Date.now()}`;
  await prisma.message.create({
    data: {
      chatId: chat.id,
      role: "user",
      content,
      compareGroup,
    },
  });

  // Build chat history
  const chatParams = chat.parameters ? JSON.parse(chat.parameters) : {};
  const options: Record<string, unknown> = {};
  if (chatParams.temperature !== undefined)
    options.temperature = chatParams.temperature;
  if (chatParams.topK !== undefined) options.top_k = chatParams.topK;
  if (chatParams.topP !== undefined) options.top_p = chatParams.topP;
  if (chatParams.repeatPenalty !== undefined)
    options.repeat_penalty = chatParams.repeatPenalty;
  if (chatParams.seed !== undefined) options.seed = chatParams.seed;
  if (chatParams.numCtx !== undefined) options.num_ctx = chatParams.numCtx;
  if (chatParams.numPredict !== undefined)
    options.num_predict = chatParams.numPredict;
  if (chatParams.stop)
    options.stop = chatParams.stop.split(",").map((s: string) => s.trim());

  const previousMessages = chat.messages
    .filter((m) => m.role === "user" || (m.role === "assistant" && !m.compareGroup))
    .map((m) => ({ role: m.role, content: m.content }));

  const allMessages = [
    ...(chatParams.systemPrompt
      ? [{ role: "system", content: chatParams.systemPrompt }]
      : []),
    ...previousMessages,
    { role: "user", content },
  ];

  const bodyBase = {
    messages: allMessages,
    stream: true,
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(chatParams.keepAlive ? { keep_alive: chatParams.keepAlive } : {}),
  };

  const startTime = Date.now();

  const upstream = new AbortController();
  req.signal?.addEventListener("abort", () => upstream.abort());

  const requests: SideRequest[] = await Promise.all(
    targets.map(async (target) => {
      const server = serverMap.get(target.serverId)!;
      try {
        const res = await fetch(buildOllamaUrl(server.url, "/api/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...bodyBase, model: target.model }),
          signal: upstream.signal,
        });
        if (!res.ok || !res.body) {
          return { target, server, res: null, error: `Ollama error: ${await readOllamaError(res)}` };
        }
        return { target, server, res, error: null };
      } catch (err) {
        return { target, server, res: null, error: formatOllamaConnectionError(server.url, err) };
      }
    })
  );

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let clientGone = false;

  const send = (controller: ReadableStreamDefaultController, payload: object) => {
    if (clientGone) return;
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    } catch {
      clientGone = true;
    }
  };

  const streamSide = async (
    controller: ReadableStreamDefaultController,
    side: string,
    { target, server, res, error }: SideRequest
  ) => {
    if (!res?.body) {
      logger.error("Compare side failed", { chatId: chat.id, model: target.model, error });
      send(controller, { side, error });
      return;
    }

    const reader = res.body.getReader();
    let buffer = "";
    let fullContent = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let streamError: string | null = null;

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let json;
      try {
        json = JSON.parse(line);
      } catch {
        return;
      }
      if (json.error) {
        streamError = String(json.error);
        return;
      }
      if (json.message?.content) {
        fullContent += json.message.content;
        send(controller, { side, token: json.message.content });
      }
      if (json.done) {
        promptTokens = json.prompt_eval_count || 0;
        completionTokens = json.eval_count || 0;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) handleLine(line);
      }
      handleLine(buffer);
    } catch (err) {
      if (!clientGone) streamError = formatOllamaConnectionError(server.url, err);
    }

    const latencyMs = Date.now() - startTime;
    const statusCode = streamError ? 502 : clientGone ? CLIENT_CLOSED_REQUEST : 200;

    try {
      if (fullContent) {
        await prisma.message.create({
          data: {
            chatId: chat.id,
            role: "assistant",
            content: fullContent,
            model: target.model,
            serverId: target.serverId,
            compareGroup,
            promptTokens,
            completionTokens,
            latencyMs,
          },
        });
      }
    } catch (err) {
      logger.error("Failed to save compare reply", { chatId: chat.id, model: target.model, error: String(err) });
      streamError ??= "The reply could not be saved. Check the server logs and database.";
    }

    logAsync({
      serverId: server.id,
      model: target.model,
      endpoint: "/api/chat/compare",
      promptTokens,
      completionTokens,
      latencyMs,
      statusCode,
    });

    if (streamError) {
      logger.error("Compare stream failed", { chatId: chat.id, model: target.model, error: streamError, savedChars: fullContent.length });
      send(controller, { side, error: streamError });
    } else {
      send(controller, { side, done: true, model: target.model, promptTokens, completionTokens, latencyMs });
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      await Promise.all(requests.map((r, idx) => streamSide(controller, String(idx), r)));

      try {
        if (chat.title === "New Conversation" && content) {
          await prisma.chat.update({
            where: { id: chat.id },
            data: { title: content.slice(0, 50) },
          });
        }
      } catch (err) {
        logger.error("Failed to update chat title", { chatId: chat.id, error: String(err) });
      }

      if (clientGone) {
        logger.info("Compare client disconnected", { chatId: chat.id, models: targets.map((t) => t.model) });
        return;
      }

      logger.info("Compare completed", {
        chatId: chat.id,
        models: targets.map((t) => t.model),
      });
      send(controller, { allDone: true });
      try {
        controller.close();
      } catch {
        // already closed by the client
      }
    },
    cancel() {
      clientGone = true;
      upstream.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
