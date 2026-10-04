import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { AppError } from "./errors.ts";
import { backgroundFailure } from "./log.ts";

type Row = { data: Record<string, unknown>; [column: string]: unknown };
interface Database {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount?: number | null }>;
  close: () => Promise<void>;
}

/**
 * How `listWhere` orders the records it returns.
 *
 * The order has to be named rather than assumed, because records of the same
 * kind do not share one time field: a run event has `date`, an agent artifact
 * has only `createdAt` inside its json. Sorting everything by `data->>'date'`
 * silently collapsed a kind with no `date` to `id` order, which flipped artifact
 * lists newest-first to oldest-first.
 *
 * `updated_desc` sorts the column the store maintains itself, so it holds for
 * any record regardless of the shape of its own fields — the order the previous
 * full `list` produced.
 */
export type ListOrder = "date_asc" | "updated_desc";

/** Fixed SQL, so no caller-supplied text ever reaches the ORDER BY clause. */
const ORDER_SQL: Record<ListOrder, string> = {
  date_asc: "data->>'date' ASC,id ASC",
  updated_desc: "updated_at DESC,id ASC",
};

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
    order: ListOrder = "date_asc",
  ): Promise<T[]> {
    const result = await this.db.query(
      `SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>$3=$4 ORDER BY ${
        ORDER_SQL[order]
      }`,
      [owner, kind, field, value],
    );
    return result.rows.map((row) => row.data as T);
  }
  /**
   * The names of the indexes defined on `records`.
   *
   * Exists so a test can assert that an index is actually registered rather than
   * inferring it from a query plan. The column is aliased to `data` because that
   * is the key this store's Database adapter exposes on every read.
   */
  async indexNames(): Promise<string[]> {
    const result = await this.db.query(
      "SELECT indexname AS data FROM pg_indexes WHERE tablename='records'",
    );
    return result.rows.map((row) => String(row.data));
  }
  /**
   * Calendar events for one calendar that overlap a time window, filtered in SQL.
   *
   * The JavaScript version read every event the owner had for the calendar and
   * compared `Date.parse(start)`/`Date.parse(end)` in memory. That is wrong twice
   * over: it scales with the owner's whole event history rather than with the
   * window, and `Date.parse` is lenient where Postgres is strict, so a malformed
   * timestamp silently became `NaN` and the comparison quietly excluded the row
   * instead of failing visibly.
   *
   * Overlap is the same rule as before: the event starts before `to` and ends
   * after `from`. Both bounds are optional, and a half-open window is a single
   * condition rather than a separate query shape.
   *
   * `start` and `end` are fixed column names, not parameters, so nothing
   * caller-supplied reaches the SQL text; only the two bounds are bound.
   *
   * The ISO-8601 shape test runs BEFORE each cast, so one malformed row is
   * skipped by the predicate instead of raising and aborting the whole statement
   * — the same hazard the claim path guards against.
   */
  async listEventsInRange<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    field: string,
    value: string,
    window: { from?: string; to?: string } = {},
  ): Promise<T[]> {
    const iso = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}";
    // An unparseable window would make every comparison false and silently
    // return nothing, so reject it here where the caller can see why.
    const isBound = (bound: string | undefined) =>
      bound === undefined || new RegExp(iso).test(bound);
    if (!isBound(window.from) || !isBound(window.to))
      throw new AppError("timeMin and timeMax must be ISO-8601 timestamps.", 400);
    const result = await this.db.query(
      `SELECT data FROM records
       WHERE owner=$1 AND kind=$2 AND data->>$3=$4
         AND data->>'start' ~ '${iso}' AND data->>'end' ~ '${iso}'
         AND ($5::timestamptz IS NULL OR (data->>'end')::timestamptz > $5::timestamptz)
         AND ($6::timestamptz IS NULL OR (data->>'start')::timestamptz < $6::timestamptz)
       ORDER BY (data->>'start')::timestamptz ASC,id ASC`,
      [owner, kind, field, value, window.from ?? null, window.to ?? null],
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
    //
    // The pattern is built in the application, so `%`, `_` and `\` have to be
    // escaped before they reach Postgres. Left raw they are wildcards: searching
    // "100%" matched every body starting with "100", and because a backslash is
    // itself an escape, searching "a\zb" dropped the row that really contained
    // it and returned an unrelated one instead. Postgres reads the default LIKE
    // escape character as a backslash, which is what `likeEscape` below relies on.
    const likeEscape = (word: string) => word.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
    const terms = words.map((word) => {
      params.push(`%${likeEscape(word)}%`);
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
       AND data->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
       AND safe_timestamptz(data->>'expiresAt')>$3::timestamptz
       AND ($4::jsonb <> '"executing"'::jsonb OR data->>'taskId' IS NULL OR EXISTS (
         SELECT 1 FROM records task WHERE task.owner=action.owner AND task.kind='tasks'
         AND task.id=action.data->>'taskId' AND task.data->>'status' IN ('running','waiting_approval')
       )) RETURNING data`,
      [owner, id, now, JSON.stringify(status)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  /**
   * Delete the rows of one kind whose numeric `expiresAt` has already passed.
   *
   * Only rows that actually look like an epoch-millisecond expiry are considered,
   * so a record missing `expiresAt` or holding something else is left alone instead
   * of failing the statement and taking every other row down with it.
   */
  async pruneExpired(owner: string, kind: string, now: number): Promise<void> {
    await this.db.query(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND data->>'expiresAt' ~ '^[0-9]+$' AND (data->>'expiresAt')::bigint<=$3",
      [owner, kind, now],
    );
  }
  /**
   * List a kind, newest first, capped.
   *
   * `ORDER BY updated_at DESC` is already served by `records_kind_updated`, so
   * adding `LIMIT` costs nothing extra and lets the caller ask for "the recent
   * ones" without pulling the entire history into memory. The kinds that grow
   * without bound — activity and run events — are exactly the ones that must
   * never be read whole.
   */
  async listRecent<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    limit: number,
  ): Promise<T[]> {
    // Bounded by the caller but clamped here too, so a bad limit cannot become a
    // full table scan wearing a different name. `Number.isFinite` is checked
    // first because Math.min/max propagate NaN: an unchecked NaN would reach
    // PostgreSQL as the string "NaN" and fail the cast with a driver error,
    // which is a far worse answer than "here are the most recent ones".
    const capped = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 1000;
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 ORDER BY updated_at DESC,id LIMIT $3",
      [owner, kind, capped],
    );
    return result.rows.map((row) => row.data as T);
  }
  /**
   * Every owner that has records.
   *
   * Used by housekeeping that has to run per owner — trimming the append-only logs
   * — without being handed a list from a caller that might forget somebody.
   * Read from the indexed leading column, and deduplicated because a table scan
   * would otherwise repeat an owner once per row.
   */
  async owners(): Promise<string[]> {
    const result = await this.db.query("SELECT DISTINCT owner FROM records ORDER BY owner");
    return result.rows.map((row) => String(row.owner));
  }
  /**
   * Delete all but the newest `keep` rows of one kind.
   *
   * Kinds like activity and run events are append-only and are never read whole,
   * so nothing ever needs the oldest rows again. Trimming them keeps the table
   * — and every index scan over it — proportional to recent history rather than
   * to how long the workspace has been in use.
   */
  async trimOlderThan(owner: string, kind: string, keep: number): Promise<number> {
    // `Number.isFinite` first, for the same reason as `listRecent`: Math.min/max
    // propagate NaN, and a NaN bound reaches PostgreSQL as "NaN" and throws.
    const bounded = Number.isFinite(keep)
      ? Math.max(1, Math.min(10_000, Math.floor(keep)))
      : 10_000;
    // One statement, so the returned count is by construction the number of rows
    // deleted — counting first and deleting second let a concurrent insert land
    // between them and report a count that was never true. The `DELETE`'s own
    // rowCount is not an option: the `pg` driver populates it, but PGlite does
    // not, and PGlite is the database OpenMuse runs on by default.
    //
    // The `NOT IN` subquery is correct because `id` is unique within
    // (owner, kind) — it is half of the table's primary key — so the newest
    // `bounded` rows are exactly the ones whose ids the subquery returns.
    const result = await this.db.query(
      `DELETE FROM records
       WHERE owner=$1 AND kind=$2
         AND id NOT IN (
           SELECT id FROM records WHERE owner=$1 AND kind=$2 ORDER BY updated_at DESC,id LIMIT $3
         )
       RETURNING id`,
      [owner, kind, bounded],
    );
    return result.rows.length;
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
  // The task worker ticks once a second and scans "tasks" (engine/worker.ts),
  // and maintain() does the same every 60s (engine/service.ts). scan() filters on
  // `kind` alone, so without this each tick reads and materialises every row of
  // every kind for every owner: the cost grows with total lifetime records rather
  // than with the number of due tasks. (kind, updated_at) serves the equality
  // filter and the existing ORDER BY, so it also removes the sort.
  await database.query(
    "CREATE INDEX IF NOT EXISTS records_kind_updated ON records(kind, updated_at)",
  );
  // Task detail reads are filtered by taskId. Without this the planner can only
  // reach them through the primary key and then discard every row of that kind,
  // which grows with the owner's whole task history. Verified with EXPLAIN: with
  // the index the taskId becomes an index condition instead of a filter.
  await database.query(
    "CREATE INDEX IF NOT EXISTS records_task_id ON records(owner,kind,(data->>'taskId'))",
  );
  // safe_timestamptz lets claim() compare expiresAt without ever throwing on
  // malformed values: bad input yields NULL, and NULL > x is not true, so the
  // row is simply skipped instead of raising a DB exception.
  //
  // The shape regex alone is not enough. `2026-13-45T00:00:00Z` and
  // `2026-02-31T00:00:00Z` both match it but are not real instants, so the
  // ::timestamptz cast still raises `22008 date/time field value out of range`
  // and takes the whole statement — and every other claimable row with it —
  // down. Catching in the function is what makes the guard total.
  await database.query(
    `CREATE OR REPLACE FUNCTION safe_timestamptz(v text) RETURNS timestamptz
     LANGUAGE plpgsql STABLE AS $$
     BEGIN
       RETURN v::timestamptz;
     EXCEPTION WHEN others THEN
       RETURN NULL;
     END;
     $$`,
  );
  return new Store(database);
}
