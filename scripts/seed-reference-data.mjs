import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL in the server environment before seeding.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
const seeds = [
  ['scenario', 'scenario.json'],
  ['products_and_recipes', 'products_and_recipes.json'],
  ['supplier', 'supplier.json'],
];

try {
  await pool.query(schema);
  for (const [key, filename] of seeds) {
    const value = JSON.parse(await readFile(new URL(`../reference-data/${filename}`, import.meta.url), 'utf8'));
    await pool.query(
      `INSERT INTO reference_data (key, value, source_filename)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         source_filename = EXCLUDED.source_filename,
         updated_at = now()`,
      [key, JSON.stringify(value), filename],
    );
    process.stdout.write(`Seeded ${key} from ${filename}\n`);
  }
} finally {
  await pool.end();
}
