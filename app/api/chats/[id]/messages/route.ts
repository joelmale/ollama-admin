import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, getRateLimitConfig } from "@/lib/rate-limit";
import { getRateLimitKey } from "@/lib/with-rate-limit";
import { logger } from "@/lib/logger";
import {
  buildOllamaUrl,
  formatOllamaConnectionError,
} from "@/lib/ollama";
import { logAsync } from "@/lib/log-async";

function buildOllamaRequest(
  chat: {
    model: string;
    parameters: string | null;
    server: { url: string };
  },
  ollamaMessages: Array<{ role: string; content: string; images?: string[] }>
) {
  const chatParams = chat.parameters ? JSON.parse(chat.parameters) : {};

  const messages = chatParams.systemPrompt
    ? [{ role: "system", content: chatParams.systemPrompt }, ...ollamaMessages]
    : ollamaMessages;

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

  return {
    url: buildOllamaUrl(chat.server.url, "/api/chat"),
    body: {
      model: chat.model,
      messages,
      stream: true,
      ...(Object.keys(options).length > 0 ? { options } : {}),
      ...(chatParams.keepAlive ? { keep_alive: chatParams.keepAlive } : {}),
    },
  };
}

const CLIENT_CLOSED_REQUEST = 499;

function createSSEStream(
  ollamaRes: Response,
  upstream: AbortController,
  chat: { id: string; title: string; server: { id: string; url: string }; model: string },
  startTime: number,
  content: string
) {
  const reader = ollamaRes.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let fullContent = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let streamError: string | null = null;
  let clientGone = false;

  const send = (controller: ReadableStreamDefaultController, text: string) => {
    if (clientGone) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      clientGone = true;
    }
  };

  const handleLine = (controller: ReadableStreamDefaultController, line: string) => {
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
    if (json.message?.content) fullContent += json.message.content;
    if (json.done) {
      promptTokens = json.prompt_eval_count || 0;
      completionTokens = json.eval_count || 0;
    }
    send(controller, `data: ${line}\n\n`);
  };

  return new ReadableStream({
    async start(controller) {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) handleLine(controller, line);
        }
        handleLine(controller, buffer);
      } catch (err) {
        if (!clientGone) streamError = formatOllamaConnectionError(chat.server.url, err);
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
              promptTokens,
              completionTokens,
              latencyMs,
            },
          });
        }

        if (chat.title === "New Conversation" && content) {
          await prisma.chat.update({
            where: { id: chat.id },
            data: { title: content.slice(0, 50) },
          });
        }
      } catch (err) {
        logger.error("Failed to save chat reply", { chatId: chat.id, error: String(err) });
        streamError ??= "The reply could not be saved. Check the server logs and database.";
      }

      logAsync({
        serverId: chat.server.id,
        model: chat.model,
        endpoint: "/api/chat",
        promptTokens,
        completionTokens,
        latencyMs,
        statusCode,
      });

      if (streamError) {
        logger.error("Chat stream failed", { chatId: chat.id, model: chat.model, error: streamError, savedChars: fullContent.length });
        send(controller, `data: ${JSON.stringify({ error: streamError })}\n\n`);
      } else if (clientGone) {
        logger.info("Chat client disconnected", { chatId: chat.id, model: chat.model, savedChars: fullContent.length });
      } else {
        logger.info("Chat completed", { chatId: chat.id, model: chat.model, promptTokens, completionTokens, latencyMs });
        send(controller, `data: ${JSON.stringify({ done: true, promptTokens, completionTokens, latencyMs })}\n\n`);
      }

      if (!clientGone) {
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      }
    },
    cancel() {
      clientGone = true;
      upstream.abort();
    },
  });
}

async function readOllamaError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.error === "string" && body.error.trim()) return body.error.trim();
  } catch {
    // not JSON
  }
  return `${res.status} ${res.statusText}`.trim();
}

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

  const { content, images, regenerate, editMessageId } = await req.json();

  const chat = await prisma.chat.findUnique({
    where: { id: id },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      server: true,
    },
  });

  if (!chat) {
    return new Response(JSON.stringify({ error: "Chat not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  let finalMessages = chat.messages;
  let userContent = content;

  if (regenerate) {
    // Only the final reply is replaced; after a failed reply the chat ends on a
    // user message and every earlier answer must survive.
    const last = chat.messages[chat.messages.length - 1];
    if (last?.role === "assistant") {
      await prisma.message.delete({ where: { id: last.id } });
      finalMessages = chat.messages.slice(0, -1);
    }
    const lastUser = [...finalMessages].reverse().find((m) => m.role === "user");
    if (!lastUser) {
      return new Response(
        JSON.stringify({ error: "There is no message to regenerate a reply for. Send a message first." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    userContent = lastUser.content;
  } else if (editMessageId) {
    const editIndex = chat.messages.findIndex((m) => m.id === editMessageId);
    if (editIndex >= 0) {
      const idsToDelete = chat.messages.slice(editIndex).map((m) => m.id);
      await prisma.message.deleteMany({
        where: { id: { in: idsToDelete } },
      });
      finalMessages = chat.messages.slice(0, editIndex);
    }

    await prisma.message.create({
      data: {
        chatId: chat.id,
        role: "user",
        content,
        images: images ? JSON.stringify(images) : null,
      },
    });
  } else {
    await prisma.message.create({
      data: {
        chatId: chat.id,
        role: "user",
        content,
        images: images ? JSON.stringify(images) : null,
      },
    });
  }

  const ollamaMessages = [
    ...finalMessages.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
      ...(m.images ? { images: JSON.parse(m.images) } : {}),
    })),
    ...(regenerate
      ? []
      : [
          {
            role: "user" as const,
            content: userContent,
            ...(images ? { images } : {}),
          },
        ]),
  ];

  const startTime = Date.now();
  logger.info("Chat request", { chatId: chat.id, model: chat.model, server: chat.server.name });

  const upstream = new AbortController();
  req.signal?.addEventListener("abort", () => upstream.abort());

  let ollamaRes: Response;
  try {
    const { url, body } = buildOllamaRequest(chat, ollamaMessages);
    ollamaRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: upstream.signal,
    });
  } catch (error) {
    const message = formatOllamaConnectionError(chat.server.url, error);
    logger.error("Ollama chat connection failed", {
      chatId: chat.id,
      error: message,
    });
    return new Response(JSON.stringify({ error: message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!ollamaRes.ok || !ollamaRes.body) {
    const detail = await readOllamaError(ollamaRes);
    logger.error("Ollama chat error", { chatId: chat.id, status: ollamaRes.status, error: detail });
    return new Response(
      JSON.stringify({ error: `Ollama error: ${detail}` }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  const stream = createSSEStream(ollamaRes, upstream, chat, startTime, userContent);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
