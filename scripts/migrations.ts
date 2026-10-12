import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "../src/lib/db";

const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "supabase", "migrations");

/**
 * Applique les migrations Supabase sur un Postgres quelconque (local, tests).
 * En production, c'est `supabase db push` qui s'en charge.
 */
export async function applyMigrations(sql: Sql, options: { reset?: boolean } = {}): Promise<string[]> {
  if (options.reset) {
    await sql.unsafe("drop schema if exists public cascade; create schema public;");
  }
  await sql`create table if not exists local_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set((await sql<{ name: string }[]>`select name from local_migrations`).map((r) => r.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const content = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`insert into local_migrations (name) values (${file})`;
    });
    newlyApplied.push(file);
  }
  return newlyApplied;
}
