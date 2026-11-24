const router = require('express').Router();
const { query } = require('../db');
const { requireLogin } = require('./guards');
const inv = require('../services/inventory');
const { toCSV } = require('./csv');

router.use(requireLogin);

// ---------------------------------------------------------------- Panel
router.get('/', async (req, res) => {
  const [low, expiring, recent, kpi] = await Promise.all([
    query(`SELECT * FROM v_item_stock WHERE active AND min_stock > 0 AND stock <= min_stock ORDER BY type, (stock/NULLIF(min_stock,0))`),
    query(`SELECT l.*, i.code, i.name, i.unit FROM v_lot_stock l JOIN items i ON i.id=l.item_id
           WHERE l.qty > 0 AND l.expiry_date IS NOT NULL AND l.expiry_date <= CURRENT_DATE + 30
           ORDER BY l.expiry_date LIMIT 20`),
    query(`SELECT p.*, i.name AS product, i.unit, u.full_name AS by_name FROM productions p
           JOIN items i ON i.id=p.product_id JOIN users u ON u.id=p.created_by
           ORDER BY p.created_at DESC LIMIT 8`),
    query(`SELECT
             (SELECT COALESCE(SUM(qty_good),0) FROM productions WHERE status='registrada' AND production_date=CURRENT_DATE) AS today_units,
             (SELECT COUNT(*) FROM productions WHERE status='registrada' AND production_date=CURRENT_DATE) AS today_batches,
             (SELECT COALESCE(SUM(qty_good),0) FROM productions WHERE status='registrada' AND production_date >= date_trunc('month', CURRENT_DATE)) AS month_units,
             (SELECT COALESCE(SUM(stock_value),0) FROM v_item_stock WHERE type IN ('MP','ENV')) AS mp_value`),
  ]);
  res.render('dashboard', { title: 'Panel', low: low.rows, expiring: expiring.rows, recent: recent.rows, kpi: kpi.rows[0] });
});

// ---------------------------------------------------------------- Inventario
router.get('/inventario', async (req, res) => {
  const { type = '', q = '' } = req.query;
  const { rows } = await query(
    `SELECT * FROM v_item_stock WHERE active AND ($1='' OR type=$1)
     AND ($2='' OR code ILIKE '%'||$2||'%' OR name ILIKE '%'||$2||'%') ORDER BY type, name`, [type, q]);
  if (req.query.csv) {
    return toCSV(res, 'inventario.csv', ['Código', 'Artículo', 'Tipo', 'Unidad', 'Stock', 'Mínimo', 'Valor RD$'],
      rows.map((r) => [r.code, r.name, r.type, r.unit, r.stock, r.min_stock, r.stock_value]));
  }
  res.render('inventory', { title: 'Inventario', items: rows, type, q });
});

router.get('/inventario/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [item] } = await query('SELECT * FROM v_item_stock WHERE id=$1', [id]);
  if (!item) return res.status(404).render('error', { title: 'No encontrado', message: 'Artículo no existe' });
  const [lots, kardex, usedIn, recipe] = await Promise.all([
    query('SELECT * FROM v_lot_stock WHERE item_id=$1 AND qty <> 0 ORDER BY expiry_date NULLS LAST, received_at', [id]),
    query(`SELECT m.*, l.lot_code, u.full_name AS by_name,
             SUM(m.qty) OVER (ORDER BY m.created_at, m.id) AS balance
           FROM movements m JOIN lots l ON l.id=m.lot_id JOIN users u ON u.id=m.user_id
           WHERE m.item_id=$1 ORDER BY m.created_at DESC, m.id DESC LIMIT 300`, [id]),
    query(`SELECT r.*, i.code, i.name FROM recipe_lines r JOIN items i ON i.id=r.product_id WHERE r.component_id=$1`, [id]),
    item.type === 'PT' ? inv.getRecipe(id) : Promise.resolve([]),
  ]);
  if (req.query.csv) {
    return toCSV(res, `kardex-${item.code}.csv`, ['Fecha', 'Tipo', 'Lote', 'Cantidad', 'Saldo', 'Costo unit.', 'Usuario', 'Nota'],
      kardex.rows.map((m) => [m.created_at.toISOString(), m.mtype, m.lot_code, m.qty, m.balance, m.unit_cost, m.by_name, m.notes]));
  }
  res.render('item', { title: item.name, item, lots: lots.rows, kardex: kardex.rows, usedIn: usedIn.rows, recipe, cap: inv.capacity(recipe) });
});

// ---------------------------------------------------------------- Producción
router.get('/produccion', async (req, res) => {
  const from = req.query.from || res.locals.today().slice(0, 8) + '01';
  const to = req.query.to || res.locals.today();
  const product = req.query.product || '';
  const { rows } = await query(
    `SELECT p.*, i.name AS product, i.code AS product_code, i.unit, u.full_name AS by_name
     FROM productions p JOIN items i ON i.id=p.product_id JOIN users u ON u.id=p.created_by
     WHERE p.production_date BETWEEN $1 AND $2 AND ($3='' OR p.product_id::text=$3)
     ORDER BY p.production_date DESC, p.id DESC`, [from, to, product]);
  const { rows: products } = await query(`SELECT id, code, name FROM items WHERE type='PT' AND active ORDER BY name`);
  if (req.query.csv) {
    return toCSV(res, 'produccion.csv', ['Registro', 'Lote', 'Envasado', 'Producto', 'Buenas', 'Rechazadas', 'Turno', 'Línea', 'Costo total', 'Estado', 'Registró'],
      rows.map((p) => [p.code, p.lot_code, p.production_date, p.product, p.qty_good, p.qty_rejected, p.shift, p.line, p.total_cost, p.status, p.by_name]));
  }
  res.render('productions', { title: 'Producción', rows, products, from, to, product });
});

router.get('/produccion/nueva', async (req, res) => {
  const { rows: products } = await query(
    `SELECT i.id, i.code, i.name, i.unit, COUNT(r.id)::int AS lines FROM items i
     LEFT JOIN recipe_lines r ON r.product_id=i.id
     WHERE i.type='PT' AND i.active GROUP BY i.id ORDER BY i.name`);
  const productId = Number(req.query.product || res.locals.form.productId) || null;
  let recipe = []; let product = null;
  if (productId) {
    product = products.find((p) => p.id === productId) || null;
    recipe = await inv.getRecipe(productId);
  }
  res.render('production_new', {
    title: 'Registrar producción', products, product, recipe, cap: inv.capacity(recipe), tolerance: inv.TOLERANCE,
  });
});

router.post('/produccion', async (req, res) => {
  const b = req.body;
  const ids = [].concat(b.componentId || []);
  const acts = [].concat(b.actualQty || []);
  const r = await inv.registerProduction(req.session.user, {
    productId: Number(b.productId), qtyGood: b.qtyGood, qtyRejected: b.qtyRejected || 0,
    date: b.date || res.locals.today(), shift: b.shift, line: b.line, elaborationDate: b.elaborationDate || null, notes: b.notes,
    consumptions: ids.map((id, i) => ({ componentId: Number(id), actualQty: acts[i] })),
  });
  req.flash('ok', `Producción registrada (${r.code}). Lote ${r.lotCode}`);
  res.redirect(`/produccion/${r.id}`);
});

router.get('/produccion/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [p] } = await query(
    `SELECT p.*, i.name AS product, i.code AS product_code, i.unit, u.full_name AS by_name, ua.full_name AS annulled_name
     FROM productions p JOIN items i ON i.id=p.product_id JOIN users u ON u.id=p.created_by
     LEFT JOIN users ua ON ua.id=p.annulled_by WHERE p.id=$1`, [id]);
  if (!p) return res.status(404).render('error', { title: 'No encontrado', message: 'Producción no existe' });
  const { rows: cons } = await query(
    `SELECT c.*, i.code, i.name, i.unit, i.type FROM production_consumptions c JOIN items i ON i.id=c.component_id
     WHERE c.production_id=$1 ORDER BY i.type, i.name`, [id]);
  const { rows: lots } = await query(
    `SELECT m.item_id, l.lot_code, -m.qty AS qty FROM movements m JOIN lots l ON l.id=m.lot_id
     WHERE m.ref_type='production' AND m.ref_id=$1 AND m.mtype='CONSUMO'`, [id]);
  res.render('production', { title: `Producción ${p.code}`, p, cons, lots, tolerance: inv.TOLERANCE });
});

module.exports = router;
