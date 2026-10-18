import { getDatabase } from "@netlify/database";

let db;
function conn() {
  if (!db) db = getDatabase();
  return db;
}

/** Run a parameterised query ($1, $2 ...) and return the rows. */
export async function q(text, params = []) {
  const res = await conn().pool.query(text, params);
  return res.rows;
}
