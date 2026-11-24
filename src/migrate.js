const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      console.log(`[migrate] aplicando ${f}`);
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }

    // Usuario administrador inicial
    const { rows: admins } = await client.query("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
    if (admins.length === 0) {
      const user = process.env.ADMIN_USER || 'admin';
      const pass = process.env.ADMIN_PASSWORD;
      if (!pass) throw new Error('Define ADMIN_PASSWORD para crear el administrador inicial');
      await client.query(
        "INSERT INTO users(username, full_name, password_hash, role) VALUES ($1,$2,$3,'admin')",
        [user, 'Administrador', bcrypt.hashSync(pass, 10)]
      );
      console.log(`[migrate] administrador inicial creado: ${user}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
}

module.exports = { migrate };
