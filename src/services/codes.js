// Códigos automáticos, únicos y correlativos. Se generan dentro de la transacción:
// UPDATE ... RETURNING bloquea la fila del contador, así dos usuarios nunca obtienen el mismo número.
const PREFIX = { MP: 'MP', ENV: 'ENV', PP: 'PP', PT: 'PT' };

async function nextCode(c, prefix, pad = 4) {
  for (;;) {
    const { rows } = await c.query(
      `INSERT INTO code_counters(prefix, last) VALUES ($1, 1)
       ON CONFLICT (prefix) DO UPDATE SET last = code_counters.last + 1 RETURNING last`, [prefix]);
    const code = `${prefix}-${String(rows[0].last).padStart(pad, '0')}`;
    // Salvaguarda ante códigos cargados a mano en versiones anteriores
    const table = prefix === 'REC' ? 'purchases' : 'items';
    const { rows: dup } = await c.query(`SELECT 1 FROM ${table} WHERE code=$1`, [code]);
    if (!dup.length) return code;
  }
}

module.exports = { nextCode, PREFIX };
