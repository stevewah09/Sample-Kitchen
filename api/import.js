import { createHash, randomUUID } from 'node:crypto';
import { getDatabase, loadCurrentState } from '../lib/database.js';
import { importOrder, validateImport, ValidationError } from '../lib/validation.js';

const headers = { 'cache-control': 'no-store' };
const reply = (value, status = 200) => Response.json(value, { status, headers });

export default {
  async fetch(request) {
    if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) return reply({ error: 'Cross-origin imports are not allowed' }, 403);
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) return reply({ error: 'Choose an import file' }, 415);
    try {
      const form = await request.formData();
      const kind = form.get('kind');
      const file = form.get('file');
      if (typeof kind !== 'string' || !importOrder.includes(kind)) return reply({ error: 'Choose a valid import type' }, 400);
      if (!file || typeof file.text !== 'function') return reply({ error: 'Choose a file' }, 400);
      if (file.size > 1_000_000) return reply({ error: 'File must be 1 MB or smaller' }, 413);
      const state = await loadCurrentState();
      const previous = importOrder[importOrder.indexOf(kind) - 1];
      if (previous && !state.batches[previous]) return reply({ error: `Import ${previous} first` }, 409);
      const text = await file.text();
      const validated = validateImport(kind, text, state.references, state.records);
      const digest = createHash('sha256').update(text).digest('hex');
      const database = await getDatabase();
      const existing = await database.query('SELECT id, content_sha256, imported_at, record_count FROM import_batches WHERE identity_key = $1', [validated.identityKey]);
      if (existing.rows.length) {
        if (existing.rows[0].content_sha256 !== digest) return reply({ error: 'This export or stock count time was already imported with different contents' }, 409);
        return reply({ status: 'already_imported', kind, export_id: validated.exportId,
          imported_at: existing.rows[0].imported_at, record_count: existing.rows[0].record_count });
      }
      const id = randomUUID();
      const client = await database.connect();
      let importedAt;
      try {
        await client.query('BEGIN');
        const inserted = await client.query(
          `INSERT INTO import_batches (id, kind, identity_key, source_system, export_id, source_filename,
             content_sha256, record_count, source_metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING imported_at`,
          [id, kind, validated.identityKey, validated.sourceSystem, validated.exportId,
            String(file.name || 'upload').replace(/^.*[\\/]/, ''), digest, validated.records.length,
            JSON.stringify(validated.metadata)],
        );
        importedAt = inserted.rows[0].imported_at;
        for (const record of validated.records) {
          await client.query('INSERT INTO import_records (batch_id, record_key, record) VALUES ($1,$2,$3::jsonb)',
            [id, validated.recordKey(record), JSON.stringify(record)]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') return reply({ error: 'This export was imported by another request; refresh the dashboard' }, 409);
        throw error;
      } finally {
        client.release();
      }
      return reply({ status: 'imported', kind, export_id: validated.exportId,
        imported_at: importedAt, record_count: validated.records.length }, 201);
    } catch (error) {
      if (error instanceof ValidationError) return reply({ error: error.message }, 422);
      return reply({ error: 'Import failed; the previous saved plan is unchanged' }, 503);
    }
  },
};
