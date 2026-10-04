import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { backgroundFailure } from "./log.ts";

type Row = { data: Record<string, unknown> };
interface Database {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  close: () => Promise<void>;
}

export class Store {
  constructor(private readonly db: Database) {}
  async get<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    id: string,
  ): Promise<T | null> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 ORDER BY updated_at DESC,id",
      [owner, kind],
    );
    return result.rows.map((row) => row.data as T);
  }
  /**
   * List only the records whose `data` carries `field = value`.
   *
   * Filtering in SQL rather than in JavaScript matters here: run events and
   * artifacts accumulate for every task the owner has ever run, so reading one
   * task's detail through a full list would scan that whole history each time.
   */
  async listWhere<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    field: string,
    value: string,
  ): Promise<T[]> {
    const result = await this.db.query(
      `SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>$3=$4 ORDER BY data->>'date' ASC,id ASC`,
      [owner, kind, field, value],
    );
    return result.rows.map((row) => row.data as T);
  }
  /**
   * Full-text search over a set of string fields inside `data`.
   *
   * Each word must appear somewhere in the concatenated fields, which is the
   * same rule the JavaScript filter applied. Doing it here means a search does
   * not pull every stored record's body into memory first.
   */
  async searchText<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    fields: readonly string[],
    words: readonly string[],
    options: { excludePattern?: { field: string; pattern: string }; order?: "date_desc" } = {},
  ): Promise<T[]> {
    // An empty query matches nothing, not everything.
    if (!words.length) return [];
    const params: unknown[] = [owner, kind];
    // A jsonb key cannot be a bind parameter, so each field name is validated
    // against an identifier pattern instead of being interpolated blindly. Every
    // *value*, including the exclusion pattern, is always bound.
    const fieldRef = (field: string) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field))
        throw new Error(`Invalid search field: ${field}`);
      params.push(field);
      // The cast is required: Postgres cannot infer the type of a bare
      // parameter used as a jsonb key, and would reject the query.
      return `data->>(${`$${params.length}`}::text)`;
    };
    const haystack = fields.map((field) => `coalesce(${fieldRef(field)},'')`).join(" || ' ' || ");
    // One ILIKE term per word, ANDed: every word must appear somewhere.
    const terms = words.map((word) => {
      params.push(`%${word.toLowerCase()}%`);
      return `(${haystack}) ILIKE ($${params.length}::text)`;
    });
    // `coalesce` mirrors the old JavaScript, which read a missing label as "".
    const exclude = options.excludePattern
      ? (() => {
          params.push(options.excludePattern.pattern);
          // Capture the placeholder *before* fieldRef pushes the key, otherwise
          // the two get numbered against each other and Postgres sees an
          // unreferenced parameter.
          const pattern = `$${params.length}::text`;
          return `coalesce(${fieldRef(options.excludePattern.field)},'') !~* (${pattern})`;
        })()
      : undefined;
    const order =
      options.order === "date_desc"
        ? "ORDER BY data->>'date' DESC,id DESC"
        : "ORDER BY data->>'date' ASC,id ASC";
    const result = await this.db.query(
      `SELECT data FROM records WHERE ${["owner=$1", "kind=$2", ...(exclude ? [exclude] : []), ...terms].join(" AND ")} ${order}`,
      params,
    );
    return result.rows.map((row) => row.data as T);
  }
  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return value;
  }
  async remove(owner: string, kind: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3", [
      owner,
      kind,
      id,
    ]);
  }
  async compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<T | null> {
    const result = await this.db.query(
      "UPDATE records SET data=data || $5::jsonb,updated_at=now() WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb RETURNING data",
      [owner, kind, id, JSON.stringify(expected), JSON.stringify(patch)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null> {
    const result = await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async scan<T>(kind: string): Promise<{ owner: string; value: T }[]> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 ORDER BY updated_at ASC",
      [kind],
    );
    return result.rows.map((row) => row.data as { owner: string; value: T });
  }
  async claim<T>(owner: string, id: string, status: string, now: string): Promise<T | null> {
    const result = await this.db.query(
      `UPDATE records AS action SET data=jsonb_set(data,'{status}',$4::jsonb),updated_at=now()
       WHERE owner=$1 AND kind='actions' AND id=$2 AND data->>'status'='awaiting_review'
       AND (data->>'expiresAt')::timestamptz>$3::timestamptz
       AND ($4::jsonb <> '"executing"'::jsonb OR data->>'taskId' IS NULL OR EXISTS (
         SELECT 1 FROM records task WHERE task.owner=action.owner AND task.kind='tasks'
         AND task.id=action.data->>'taskId' AND task.data->>'status' IN ('running','waiting_approval')
       )) RETURNING data`,
      [owner, id, now, JSON.stringify(status)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async recoverInterruptedActions(): Promise<void> {
    await this.db.query(
      `UPDATE records SET data=data || '{"status":"outcome_unknown","error":"Server restarted during execution. Check the provider before creating another action."}'::jsonb WHERE kind='actions' AND data->>'status'='executing'`,
    );
  }
  async take<T>(owner: string, kind: string, id: string): Promise<T | null> {
    const result = await this.db.query(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3 RETURNING data",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  close(): Promise<void> {
    return this.db.close();
  }
  async updateCredential(owner: string, connectionId: string, secret: string): Promise<boolean> {
    const result = await this.db.query(
      "UPDATE records SET data=jsonb_set(data,'{secret}',$3::jsonb),updated_at=now() WHERE owner=$1 AND kind='credentials' AND id='google' AND data->>'connectionId'=$2 RETURNING data",
      [owner, connectionId, JSON.stringify(secret)],
    );
    return result.rows.length === 1;
  }
}

/** Idle clients can be disconnected by a database restart; without a listener pg's `error` event crashes the process. */
export function createPool(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  pool.on("error", (error) => backgroundFailure("postgres pool", error));
  return pool;
}

export async function createStore(
  options: { dataDir?: string; databaseUrl?: string } = {},
): Promise<Store> {
  let database: Database;
  if (options.databaseUrl) {
    const pool = createPool(options.databaseUrl);
    database = { query: async (sql, params) => pool.query(sql, params), close: () => pool.end() };
  } else {
    if (options.dataDir) await mkdir(dirname(options.dataDir), { recursive: true, mode: 0o700 });
    const embedded = new PGlite(options.dataDir);
    await embedded.waitReady;
    database = {
      query: (sql, params) => embedded.query<Row>(sql, params),
      close: () => embedded.close(),
    };
  }
  await database.query(
    "CREATE TABLE IF NOT EXISTS records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))",
  );
  // Task detail reads are filtered by taskId. Without this the planner can only
  // reach them through the primary key and then discard every row of that kind,
  // which grows with the owner's whole task history. Verified with EXPLAIN: with
  // the index the taskId becomes an index condition instead of a filter.
  await database.query(
    "CREATE INDEX IF NOT EXISTS records_task_id ON records(owner,kind,(data->>'taskId'))",
  );
  return new Store(database);
}
