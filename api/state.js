import { databaseConfigured, getDatabase, loadCurrentState } from '../lib/database.js';
import { calculatePlan } from '../lib/planning.js';

const headers = { 'cache-control': 'no-store' };

export default {
  async fetch(request) {
    if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
    if (!databaseConfigured()) return Response.json({ error: 'Database is not configured' }, { status: 503, headers });
    try {
      const state = await loadCurrentState();
      const imports = Object.fromEntries(Object.entries(state.batches).map(([kind, batch]) => [kind, {
        source_system: batch.source_system, export_id: batch.export_id, source_filename: batch.source_filename,
        imported_at: batch.imported_at, record_count: batch.record_count, source_metadata: batch.source_metadata,
      }]));
      const plan = calculatePlan(state);
      let agentRun = null;
      if (plan.status === 'ready') {
        const database = await getDatabase();
        const result = await database.query(
          `SELECT id, import_version, model, recommendations, handoff_trace, created_at
           FROM planning_agent_runs WHERE import_version = $1 ORDER BY created_at DESC LIMIT 1`,
          [plan.import_version],
        );
        agentRun = result.rows[0] || null;
      }
      return Response.json({ imports, reference_keys: Object.keys(state.references), plan, agent_run: agentRun }, { headers });
    } catch {
      return Response.json({ error: 'Could not load saved planning data' }, { status: 503, headers });
    }
  },
};
