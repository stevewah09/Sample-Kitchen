let poolPromise;

async function getPool() {
  if (!poolPromise) {
    poolPromise = import('pg').then(({ default: pg }) => new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 3_000,
    }));
  }
  return poolPromise;
}

export default {
  async fetch() {
    if (!process.env.DATABASE_URL) {
      return Response.json({ status: 'ready', database: 'not_configured' });
    }

    try {
      const pool = await getPool();
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
