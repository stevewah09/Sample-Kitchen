import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const seeds = [
  ['scenario', 'scenario.json'],
  ['products_and_recipes', 'products_and_recipes.json'],
  ['supplier', 'supplier.json'],
];

let pool;
let ready;

export function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export async function getDatabase() {
  if (!databaseConfigured()) throw new Error('DATABASE_URL is not configured');
  const connectionUrl = new URL(process.env.DATABASE_URL);
  connectionUrl.searchParams.set('sslmode', 'verify-full');
  pool ??= new Pool({
    connectionString: connectionUrl.toString(),
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  ready ??= initialize(pool).catch((error) => {
    ready = undefined;
    throw error;
  });
  await ready;
  return pool;
}

async function initialize(connection) {
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await connection.query(schema);
  for (const [key, filename] of seeds) {
    const value = JSON.parse(await readFile(new URL(`../reference-data/${filename}`, import.meta.url), 'utf8'));
    await connection.query(
      `INSERT INTO reference_data (key, value, source_filename)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         source_filename = EXCLUDED.source_filename,
         updated_at = now()
       WHERE reference_data.value IS DISTINCT FROM EXCLUDED.value
          OR reference_data.source_filename IS DISTINCT FROM EXCLUDED.source_filename`,
      [key, JSON.stringify(value), filename],
    );
  }
}

export async function loadCurrentState() {
  const connection = await getDatabase();
  const [batchResult, referenceResult] = await Promise.all([
    connection.query(`SELECT DISTINCT ON (kind) id, kind, identity_key, source_system, export_id,
                        source_filename, content_sha256, imported_at, record_count, source_metadata
                      FROM import_batches ORDER BY kind, imported_at DESC, id DESC`),
    connection.query('SELECT key, value, updated_at FROM reference_data'),
  ]);
  const batches = Object.fromEntries(batchResult.rows.map((row) => [row.kind, row]));
  const references = Object.fromEntries(referenceResult.rows.map((row) => [row.key, row.value]));
  const ids = batchResult.rows.map((row) => row.id);
  const records = Object.fromEntries(batchResult.rows.map((row) => [row.kind, []]));
  if (ids.length) {
    const rows = await connection.query(
      'SELECT batch_id, record_key, record FROM import_records WHERE batch_id = ANY($1::text[]) ORDER BY record_key',
      [ids],
    );
    const kinds = Object.fromEntries(batchResult.rows.map((row) => [row.id, row.kind]));
    for (const row of rows.rows) records[kinds[row.batch_id]].push(row.record);
  }
  return { batches, records, references };
}
