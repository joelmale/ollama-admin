// Creates a throwaway SQLite database for Playwright: migrated, setup marked
// complete, and one server row so the chat and admin pages have data to show.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const dbFile = "e2e/.tmp/e2e.db";
mkdirSync("e2e/.tmp", { recursive: true });
rmSync(dbFile, { force: true });
rmSync(`${dbFile}-journal`, { force: true });

process.env.DATABASE_URL = `file:${process.cwd().replaceAll("\\", "/")}/${dbFile}`;
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
  stdio: "inherit",
  env: process.env,
});

const prisma = new PrismaClient();
await prisma.settings.create({ data: { key: "setup_completed", value: "true" } });
await prisma.server.create({ data: { name: "E2E Ollama", url: "http://127.0.0.1:11434" } });
await prisma.$disconnect();
