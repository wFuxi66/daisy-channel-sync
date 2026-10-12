import { createSql } from "../src/lib/db";
import { applyMigrations } from "./migrations";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL manquant (voir .env.example)");

const sql = createSql(url, { max: 1, onnotice: () => {} });
const reset = process.argv.includes("--reset");
const applied = await applyMigrations(sql, { reset });
console.log(applied.length ? `Migrations appliquées : ${applied.join(", ")}` : "Base déjà à jour.");
await sql.end();
