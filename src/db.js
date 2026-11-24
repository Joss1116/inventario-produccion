const { Pool, types } = require('pg');

// NUMERIC -> Number (cantidades con hasta 6 decimales; suficiente para inventario)
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
// DATE -> 'YYYY-MM-DD' sin conversión de zona horaria
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

// Fechas de negocio (CURRENT_DATE, now()) en hora local de la planta
pool.on('connect', (c) => c.query(`SET TIME ZONE '${process.env.TZ || 'America/Santo_Domingo'}'`));

async function query(text, params) {
  return pool.query(text, params);
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
