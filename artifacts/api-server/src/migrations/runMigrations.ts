/**
 * runMigrations.ts — lightweight, idempotent SQL migration runner.
 *
 * Applies the repo-level drizzle/*.sql migrations, tracked in a
 * `_migrations` bookkeeping table so each file runs exactly once.
 * The whole run is bounded by a timeout so startup is never blocked
 * by a slow or unreachable database.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";

const MIGRATIONS_TABLE = `_migrations`;

function candidateDirs(): string[] {
  const dirs: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/migrations -> <repo>/drizzle and dist/migrations -> <repo>/drizzle
    dirs.push(path.resolve(here, "../../../drizzle"));
    dirs.push(path.resolve(here, "../../../../drizzle"));
  } catch {
    /* import.meta.url unavailable — fall through to cwd-based paths */
  }
  dirs.push(path.resolve(process.cwd(), "drizzle"));
  dirs.push(path.resolve(process.cwd(), "../../drizzle"));
  return dirs;
}

async function findMigrationsDir(): Promise<string | null> {
  for (const dir of candidateDirs()) {
    try {
      const entries = await readdir(dir);
      if (entries.some((f) => f.endsWith(".sql"))) return dir;
    } catch {
      /* not here — try next candidate */
    }
  }
  return null;
}

async function applyWithTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`migrations timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run pending migrations, bounded by `timeoutMs`.
 * Idempotent: already-applied files (recorded in `_migrations`) are skipped.
 */
export async function runMigrations(timeoutMs = 10_000): Promise<void> {
  await applyWithTimeout(
    (async () => {
      const dir = await findMigrationsDir();
      if (!dir) {
        logger.info("[migrations] no drizzle SQL directory found — skipping");
        return;
      }

      await pool.query(
        `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
           "name"      text PRIMARY KEY,
           "applied_at" timestamp DEFAULT now() NOT NULL
         )`,
      );

      const { rows } = await pool.query<{ name: string }>(`SELECT "name" FROM "${MIGRATIONS_TABLE}"`);
      const applied = new Set(rows.map((r) => r.name));

      const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await readFile(path.join(dir, file), "utf8");
        const statements = sql
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const stmt of statements) {
            try {
              await client.query(stmt);
            } catch (err: any) {
              // Idempotency guard: tolerate "already exists" style errors so
              // partially-applied historical migrations can complete.
              const code = err?.code;
              if (code === "42P07" || code === "42710" || code === "42701") continue;
              throw err;
            }
          }
          await client.query(`INSERT INTO "${MIGRATIONS_TABLE}" ("name") VALUES ($1)`, [file]);
          await client.query("COMMIT");
          logger.info({ file }, "[migrations] applied");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }
    })(),
    timeoutMs,
  );
}

export default runMigrations;
