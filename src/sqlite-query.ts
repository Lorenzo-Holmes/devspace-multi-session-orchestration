import Database from "better-sqlite3";

export type SqliteQueryParameter = string | number | null;

export interface SqliteQueryResult {
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  truncated: boolean;
}

const MAX_CELL_CHARS = 16_000;
const MAX_RESULT_CHARS = 500_000;

export function querySqliteReadOnly(
  path: string,
  sql: string,
  parameters: SqliteQueryParameter[],
  maxRows: number,
): SqliteQueryResult {
  const database = new Database(path, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000,
  });

  try {
    database.pragma("query_only = ON");
    const statement = database.prepare(sql);
    if (!statement.readonly || !statement.reader) {
      throw new Error(
        "query_sqlite only accepts one read-only statement that returns rows.",
      );
    }

    const columns = statement.columns().map((column) => column.name);
    const rows: SqliteQueryResult["rows"] = [];
    let resultChars = 2;
    let truncated = false;

    for (const value of statement.iterate(...parameters)) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }

      const row = normalizeRow(value as Record<string, unknown>);
      const rowChars = JSON.stringify(row).length + (rows.length === 0 ? 0 : 1);
      if (resultChars + rowChars > MAX_RESULT_CHARS) {
        truncated = true;
        break;
      }

      rows.push(row);
      resultChars += rowChars;
    }

    return { columns, rows, truncated };
  } finally {
    database.close();
  }
}

function normalizeRow(
  row: Record<string, unknown>,
): Record<string, string | number | null> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]),
  );
}

function normalizeValue(value: unknown): string | number | null {
  if (value === null || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return value.length <= MAX_CELL_CHARS
      ? value
      : `${value.slice(0, MAX_CELL_CHARS)}…[truncated]`;
  }
  if (Buffer.isBuffer(value)) return `[BLOB ${value.byteLength} bytes]`;
  return String(value);
}
