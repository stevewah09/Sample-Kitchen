import { randomUUID } from 'node:crypto';
import { getDatabase, loadCurrentState } from '../lib/database.js';
import { calculatePlan } from '../lib/planning.js';
import { createGmailDraft } from '../lib/zapier.js';
import { draftHash, supplierDraft, validateDraft } from '../lib/draft.js';

const headers = { 'cache-control': 'no-store' };
const reply = (body, status = 200) => Response.json(body, { status, headers });

export default {
  async fetch(request) {
    if (!['GET', 'POST'].includes(request.method)) return reply({ error: 'Method not allowed' }, 405);
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) return reply({ error: 'Cross-origin draft actions are not allowed' }, 403);
    try {
      const state = await loadCurrentState();
      const plan = calculatePlan(state);
      if (plan.status !== 'ready') return reply({ error: 'Import all five files before preparing a draft' }, 409);
      const database = await getDatabase();
      const run = await database.query('SELECT id FROM planning_agent_runs WHERE import_version = $1 LIMIT 1', [plan.import_version]);
      if (!run.rowCount) return reply({ error: 'Run the planning agents for the current imports first' }, 409);
      if (request.method === 'GET') {
        const saved = await database.query(
          `SELECT id, to_address, subject, body, status, created_at, completed_at
           FROM gmail_draft_requests WHERE import_version = $1 ORDER BY created_at DESC LIMIT 1`,
          [plan.import_version],
        );
        return reply({ preview: supplierDraft(plan, state.references.supplier),
          configured: Boolean(process.env.ZAPIER_MCP_TOKEN), saved: saved.rows[0] || null });
      }
      if (!process.env.ZAPIER_MCP_TOKEN) return reply({ error: 'Server-side Zapier MCP connection is not configured' }, 503);
      const payload = await request.json();
      if (payload?.manager_reviewed !== true) return reply({ error: 'Manager review is required before creating a draft' }, 400);
      const draft = validateDraft(payload);
      const hash = draftHash(plan.import_version, draft);
      let id = randomUUID();
      const inserted = await database.query(
        `INSERT INTO gmail_draft_requests (id, import_version, draft_sha256, to_address, subject, body, status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT (draft_sha256) DO NOTHING RETURNING id`,
        [id, plan.import_version, hash, draft.to, draft.subject, draft.body],
      );
      if (!inserted.rowCount) {
        const previous = await database.query('SELECT id, status FROM gmail_draft_requests WHERE draft_sha256 = $1', [hash]);
        if (previous.rows[0]?.status !== 'uncertain' || payload.confirmed_absent !== true) {
          return reply({ error: 'This draft was already requested. Check Gmail Drafts and Zapier History before trying again.' }, 409);
        }
        const reset = await database.query(
          `UPDATE gmail_draft_requests SET status = 'pending', provider_result = NULL, completed_at = NULL
           WHERE id = $1 AND status = 'uncertain' RETURNING id`, [previous.rows[0].id],
        );
        if (!reset.rowCount) return reply({ error: 'Another draft attempt is already in progress' }, 409);
        id = reset.rows[0].id;
      }
      try {
        const provider = await createGmailDraft(draft);
        const saved = await database.query(
          `UPDATE gmail_draft_requests SET status = 'created', provider_result = $2::jsonb, completed_at = now()
           WHERE id = $1 RETURNING id, to_address, subject, status, created_at, completed_at`,
          [id, JSON.stringify(provider)],
        );
        return reply({ saved: saved.rows[0], message: 'Gmail draft created. Verify it appears unsent in Drafts.' }, 201);
      } catch (error) {
        await database.query(`UPDATE gmail_draft_requests SET status = 'uncertain', completed_at = now() WHERE id = $1`, [id]);
        return reply({ error: `${error.message}. Check Gmail Drafts and Zapier History before retrying; the app will not automatically repeat this action.` }, 502);
      }
    } catch (error) {
      return reply({ error: `Could not prepare Gmail draft: ${error.message}` }, 503);
    }
  },
};
