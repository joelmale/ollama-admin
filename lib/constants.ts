export const DEFAULT_OLLAMA_URL =
  process.env.DEFAULT_OLLAMA_URL || "http://localhost:11434";

export const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";

export const CATALOG_REFRESH_ENABLED =
  process.env.CATALOG_REFRESH_ENABLED !== "false";
