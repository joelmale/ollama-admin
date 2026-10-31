// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(process.cwd(), "scripts/backup-sqlite.sh");
let dir: string;
let fakePrisma: string;

function run(pending: boolean, extraEnv: Record<string, string> = {}) {
  execFileSync("sh", [script], {
    env: {
      ...process.env,
      // Forward slashes keep the path a single file: URL on Windows too.
      DATABASE_URL: `file:${join(dir, "app.db").replace(/\\/g, "/")}`,
      PRISMA_BIN: fakePrisma,
      FAKE_MIGRATE_STATUS: pending ? "1" : "0",
      ...extraEnv,
    },
    stdio: "pipe",
  });
}

function backups() {
  const backupDir = join(dir, "backups");
  return existsSync(backupDir) ? readdirSync(backupDir).filter((f) => f.endsWith(".bak")) : [];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oa-backup-"));
  fakePrisma = join(dir, "fake-prisma.js");
  writeFileSync(fakePrisma, "process.exit(Number(process.env.FAKE_MIGRATE_STATUS));\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scripts/backup-sqlite.sh", () => {
  it("copies the database when migrations are pending", () => {
    writeFileSync(join(dir, "app.db"), "data");

    run(true);

    expect(backups()).toHaveLength(1);
  });

  it("does nothing when the schema is up to date", () => {
    writeFileSync(join(dir, "app.db"), "data");

    run(false);

    expect(backups()).toHaveLength(0);
  });

  it("does nothing on a fresh install", () => {
    run(true);

    expect(backups()).toHaveLength(0);
  });

  it("keeps only the newest DB_BACKUP_KEEP backups", () => {
    writeFileSync(join(dir, "app.db"), "data");
    mkdirSync(join(dir, "backups"));
    for (const stamp of ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z"]) {
      writeFileSync(join(dir, "backups", `app.db.${stamp}.bak`), "old");
    }

    run(true, { DB_BACKUP_KEEP: "2" });

    expect(backups()).toHaveLength(2);
  });
});
