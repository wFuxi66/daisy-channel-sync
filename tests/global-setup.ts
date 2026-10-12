import { createSql } from "../src/lib/db";
import { applyMigrations } from "../scripts/migrations";
import { TEST_DATABASE_URL } from "./helpers/env";

export default async function setup() {
  const sql = createSql(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await applyMigrations(sql, { reset: true });
  } catch (error) {
    throw new Error(
      `Base de test injoignable ou migration en échec (${TEST_DATABASE_URL}). Lancer \`docker compose up -d\`.\n${error}`,
    );
  } finally {
    await sql.end();
  }
}
