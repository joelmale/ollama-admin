import { logger } from "@/lib/logger";
import {
  buildOllamaUrl,
  formatOllamaConnectionError,
} from "@/lib/ollama";

export interface PullJob {
  id: string;
  model: string;
  tag: string;
  serverId: string;
  status: "pulling" | "done" | "error";
  progress: number;
  error?: string;
  lastActivityAt: number;
}

const CLEANUP_DELAY_MS = 30_000;
// Ollama reports progress continuously; this long without a byte means the
// pull is stuck (large digest verification stays well under it).
export const PULL_IDLE_TIMEOUT_MS = 5 * 60_000;

class PullManager {
  private jobs = new Map<string, PullJob>();
  private _pending = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();

  startPull(serverId: string, serverUrl: string, modelRef: string): PullJob {
    const [model, tag] = modelRef.includes(":")
      ? modelRef.split(":", 2)
      : [modelRef, "latest"];

    const id = `${serverId}:${modelRef}`;

    const existing = this.jobs.get(id);
    if (existing && existing.status === "pulling") {
      if (Date.now() - existing.lastActivityAt < PULL_IDLE_TIMEOUT_MS) return existing;
      this.controllers.get(id)?.abort();
    }

    const job: PullJob = { id, model, tag, serverId, status: "pulling", progress: 0, lastActivityAt: Date.now() };
    this.jobs.set(id, job);

    const promise = this.runPull(job, serverUrl, modelRef);
    this._pending.set(id, promise);
    promise.finally(() => this._pending.delete(id));
    return job;
  }

  getStatus(serverId?: string): PullJob[] {
    const jobs = Array.from(this.jobs.values());
    if (serverId) return jobs.filter((j) => j.serverId === serverId);
    return jobs;
  }

  private async runPull(job: PullJob, serverUrl: string, modelRef: string) {
    logger.info("Pull started", { model: modelRef, serverId: job.serverId });

    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idled = false;
    const touch = () => {
      job.lastActivityAt = Date.now();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idled = true;
        controller.abort();
      }, PULL_IDLE_TIMEOUT_MS);
    };
    touch();

    try {
      const url = buildOllamaUrl(serverUrl, "/api/pull");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelRef, stream: true }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let detail = `${res.status} ${res.statusText}`;
        try {
          const body = await res.json();
          if (body?.error) detail = body.error.replace(/[\n\t]+/g, " ").trim();
        } catch {
          // use status text as fallback
        }
        this.fail(job, detail);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let succeeded = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        touch();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.error) {
              this.fail(job, data.error.replace(/[\n\t]+/g, " ").trim());
              return;
            }
            if (data.status === "success") succeeded = true;
            if (typeof data.total === "number" && data.total > 0 && typeof data.completed === "number") {
              job.progress = Math.round((data.completed / data.total) * 100);
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      if (!succeeded) {
        this.fail(job, "Ollama closed the connection before the pull finished. Try the pull again.");
        return;
      }
      job.status = "done";
      job.progress = 100;
      logger.info("Pull completed", { model: modelRef });
      this.scheduleCleanup(job.id);
    } catch (e) {
      if (this.jobs.get(job.id) !== job) return;
      this.fail(
        job,
        idled
          ? `No progress from Ollama for ${PULL_IDLE_TIMEOUT_MS / 60_000} minutes; the pull was stopped. Try again.`
          : formatOllamaConnectionError(serverUrl, e)
      );
    } finally {
      clearTimeout(idleTimer);
      if (this.controllers.get(job.id) === controller) this.controllers.delete(job.id);
    }
  }

  private fail(job: PullJob, error: string) {
    job.status = "error";
    job.error = error;
    logger.error("Pull failed", { model: `${job.model}:${job.tag}`, error });
    this.scheduleCleanup(job.id);
  }

  private scheduleCleanup(id: string) {
    const job = this.jobs.get(id);
    setTimeout(() => {
      if (this.jobs.get(id) === job) this.jobs.delete(id);
    }, CLEANUP_DELAY_MS);
  }
}

const globalForPull = globalThis as unknown as {
  pullManager: PullManager | undefined;
};

export const pullManager =
  globalForPull.pullManager ?? new PullManager();

if (process.env.NODE_ENV !== "production")
  globalForPull.pullManager = pullManager;
