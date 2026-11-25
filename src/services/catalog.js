// Catálogo: artículos con código automático, marcas, fórmulas y presentaciones.
const { tx, query } = require('../db');
const { nextCode } = require('./codes');
const { AppError, round4 } = require('./inventory');

const PACKAGING_TYPES = ['Botella', 'Galón', 'Garrafa', 'Frasco', 'Pote', 'Atomizador', 'Tapa', 'Válvula / gatillo', 'Etiqueta', 'Caja', 'Funda', 'Otro'];
const num = (v) => (v === '' || v === undefined || v === null ? null : Number(String(v).replace(',', '.')));
const clean = (v) => (v || '').trim();

async function ensureBrand(c, name) {
  const n = clean(name);
  if (!n) throw new AppError('Indica la marca del producto');
  const { rows } = await c.query('SELECT id FROM brands WHERE lower(name)=lower($1)', [n]);
  if (rows[0]) return rows[0].id;
  const { rows: ins } = await c.query('INSERT INTO brands(name) VALUES ($1) RETURNING id', [n]);
  return ins[0].id;
}

// Crea o actualiza MP / ENV / PP. El código lo asigna el sistema y no se puede cambiar.
async function saveItem(b) {
  const type = b.type;
  if (!['MP', 'ENV', 'PP'].includes(type)) throw new AppError('Tipo inválido');
  if (!clean(b.name)) throw new AppError('El nombre es obligatorio');
  if (!clean(b.unit)) throw new AppError('La unidad de medida es obligatoria');
  return tx(async (c) => {
    const brandId = type === 'PP' ? await ensureBrand(c, b.brand) : null;
    const f = [clean(b.name), clean(b.unit), num(b.min_stock) || 0, clean(b.notes) || null, brandId,
      type === 'ENV' ? clean(b.packaging_type) || 'Otro' : null,
      type === 'ENV' ? num(b.capacity) : null,
      type === 'ENV' ? clean(b.capacity_unit) || null : null];
    if (b.id) {
      const { rows } = await c.query('SELECT type FROM items WHERE id=$1', [b.id]);
      if (!rows[0] || rows[0].type !== type) throw new AppError('Artículo no encontrado');
      await c.query(`UPDATE items SET name=$2, unit=$3, min_stock=$4, notes=$5, brand_id=$6, packaging_type=$7, capacity=$8, capacity_unit=$9, active=$10 WHERE id=$1`,
        [b.id, ...f, b.active === 'on' || b.active === true]);
      return { id: Number(b.id) };
    }
    const code = await nextCode(c, type);
    const { rows } = await c.query(
      `INSERT INTO items(code, type, name, unit, min_stock, notes, brand_id, packaging_type, capacity, capacity_unit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [code, type, ...f]);
    return { id: rows[0].id, code };
  });
}

// Fórmula de un producto preparado: solo materias primas, por 1 unidad de PP
async function savePPFormula(productId, lines) {
  return tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM items WHERE id=$1 AND type='PP'", [productId]);
    if (!rows[0]) throw new AppError('Producto preparado no encontrado');
    const valid = lines.filter((l) => l.c && l.q > 0);
    if (new Set(valid.map((l) => l.c)).size !== valid.length) throw new AppError('Una materia prima aparece repetida');
    for (const l of valid) {
      const { rows: it } = await c.query('SELECT type FROM items WHERE id=$1', [l.c]);
      if (it[0]?.type !== 'MP') throw new AppError('La fórmula de preparación solo lleva materias primas');
    }
    await c.query('DELETE FROM recipe_lines WHERE product_id=$1', [productId]);
    for (const l of valid) {
      await c.query('INSERT INTO recipe_lines(product_id, component_id, qty_per_unit, waste_pct) VALUES ($1,$2,$3,$4)', [productId, l.c, l.q, l.w || 0]);
    }
    return valid.length;
  });
}

// Producto terminado = producto preparado + presentación + envases que lleva
async function savePT(b, envLines) {
  const bulkId = Number(b.bulk_id);
  const content = num(b.content_qty);
  if (!bulkId) throw new AppError('Selecciona el producto preparado que se envasa');
  if (!clean(b.presentation)) throw new AppError('Indica la presentación (ej. Galón, 1 L, 500 ml)');
  if (!(content > 0)) throw new AppError('Indica cuánto producto preparado lleva cada unidad');
  const envs = envLines.filter((l) => l.c && l.q > 0);
  if (!envs.length) throw new AppError('Indica al menos un envase (botella, tapa, etiqueta…)');
  if (new Set(envs.map((l) => l.c)).size !== envs.length) throw new AppError('Un envase aparece repetido');

  return tx(async (c) => {
    const { rows: bk } = await c.query(
      `SELECT i.*, b.name AS brand FROM items i LEFT JOIN brands b ON b.id=i.brand_id WHERE i.id=$1 AND i.type='PP'`, [bulkId]);
    const bulk = bk[0];
    if (!bulk) throw new AppError('Producto preparado no encontrado');
    for (const l of envs) {
      const { rows: it } = await c.query('SELECT type FROM items WHERE id=$1', [l.c]);
      if (it[0]?.type !== 'ENV') throw new AppError('Solo se pueden agregar envases / empaques');
    }
    const name = `${bulk.name} ${bulk.brand ? bulk.brand + ' ' : ''}${clean(b.presentation)}`.replace(/\s+/g, ' ').trim();
    let id = Number(b.id) || null;
    if (id) {
      const { rows } = await c.query("SELECT 1 FROM items WHERE id=$1 AND type='PT'", [id]);
      if (!rows[0]) throw new AppError('Producto terminado no encontrado');
      await c.query(`UPDATE items SET name=$2, bulk_id=$3, presentation=$4, brand_id=$5, min_stock=$6, notes=$7, active=$8 WHERE id=$1`,
        [id, name, bulkId, clean(b.presentation), bulk.brand_id, num(b.min_stock) || 0, clean(b.notes) || null, b.active === 'on']);
    } else {
      const code = await nextCode(c, 'PT');
      const { rows } = await c.query(
        `INSERT INTO items(code, type, name, unit, bulk_id, presentation, brand_id, min_stock, notes)
         VALUES ($1,'PT',$2,'und',$3,$4,$5,$6,$7) RETURNING id`,
        [code, name, bulkId, clean(b.presentation), bulk.brand_id, num(b.min_stock) || 0, clean(b.notes) || null]);
      id = rows[0].id;
    }
    await c.query('DELETE FROM recipe_lines WHERE product_id=$1', [id]);
    await c.query('INSERT INTO recipe_lines(product_id, component_id, qty_per_unit, waste_pct) VALUES ($1,$2,$3,$4)',
      [id, bulkId, round4(content), num(b.content_waste) || 0]);
    for (const l of envs) {
      await c.query('INSERT INTO recipe_lines(product_id, component_id, qty_per_unit, waste_pct) VALUES ($1,$2,$3,$4)', [id, l.c, l.q, l.w || 0]);
    }
    return { id, name };
  });
}

async function listItems(types) {
  const { rows } = await query(
    `SELECT s.*, b.name AS brand, bk.name AS bulk_name FROM v_item_stock s
     LEFT JOIN brands b ON b.id=s.brand_id LEFT JOIN items bk ON bk.id=s.bulk_id
     WHERE s.type = ANY($1) ORDER BY s.active DESC, s.type, s.name`, [types]);
  return rows;
}

module.exports = { PACKAGING_TYPES, saveItem, savePPFormula, savePT, listItems, num };
