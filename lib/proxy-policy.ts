// Endpoints that only run or inspect models. Everything else (pull, push,
// create, copy, delete, blobs) changes what is installed and needs an admin.
const CLIENT_ENDPOINTS = new Set([
  "/api/chat",
  "/api/generate",
  "/api/embed",
  "/api/embeddings",
  "/api/tags",
  "/api/show",
  "/api/ps",
  "/api/version",
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
  "/v1/models",
]);

const GENERATION_ENDPOINTS = new Set([
  "/api/chat",
  "/api/generate",
  "/api/embed",
  "/api/embeddings",
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
]);

export const PROXY_QUICK_TIMEOUT_MS = 15_000;

function normalize(path: string) {
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") end--;
  return path.slice(0, end) || "/";
}

export function isClientEndpoint(path: string) {
  return CLIENT_ENDPOINTS.has(normalize(path));
}

/** Generation can legitimately wait minutes for a model to load; metadata calls cannot. */
export function proxyTimeoutMs(path: string): number | null {
  return GENERATION_ENDPOINTS.has(normalize(path)) ? null : PROXY_QUICK_TIMEOUT_MS;
}
