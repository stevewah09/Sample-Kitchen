import { databaseConfigured, getDatabase } from '../lib/database.js';

export default {
  async fetch() {
    if (!databaseConfigured()) {
      return Response.json({ status: 'ready', database: 'not_configured' });
    }

    try {
      const pool = await getDatabase();
      await pool.query('SELECT 1');
      return Response.json({ status: 'ready', database: 'connected' });
    } catch {
      return Response.json(
        { status: 'degraded', database: 'unavailable' },
        { status: 503 },
      );
    }
  },
};
