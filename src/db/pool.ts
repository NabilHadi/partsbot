import pg from "pg";

export type Db = pg.Pool;

export function createPool(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on("error", (err) => console.error("pg pool error", err));
  return pool;
}
