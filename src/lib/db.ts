import postgres from "postgres";

export type Sql = postgres.Sql;
/** Une connexion ou une transaction : les fonctions du domaine acceptent les deux. */
export type Db = postgres.Sql | postgres.TransactionSql;

export function createSql(url: string, options: postgres.Options<{}> = {}): Sql {
  return postgres(url, {
    // Supavisor (pooler Supabase) en mode transaction ne supporte pas les requêtes préparées.
    prepare: false,
    max: 10,
    ...options,
  });
}

const globalForDb = globalThis as unknown as { daisySql?: Sql };

/** Client partagé par le serveur Next (survit au rechargement à chaud en dev). */
export function getSql(): Sql {
  if (!globalForDb.daisySql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL manquant");
    globalForDb.daisySql = createSql(url, { max: 5 });
  }
  return globalForDb.daisySql;
}
