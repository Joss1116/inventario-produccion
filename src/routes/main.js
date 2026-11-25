const router = require('express').Router();
const { query } = require('../db');
const { requireLogin } = require('./guards');
const inv = require('../services/inventory');
const { toCSV } = require('./csv');

router.use(requireLogin);

// ---------------------------------------------------------------- Panel
router.get('/', async (req, res) => {
  const [low, expiring, recent, kpi, bulkLots] = await Promise.all([
    query(`SELECT * FROM v_item_stock WHERE active AND min_stock > 0 AND stock <= min_stock ORDER BY type, (stock/NULLIF(min_stock,0))`),
    query(`SELECT l.*, i.code, i.name, i.unit FROM v_lot_stock l JOIN items i ON i.id=l.item_id
           WHERE l.qty > 0 AND l.expiry_date IS NOT NULL AND l.expiry_date <= CURRENT_DATE + 30
           ORDER BY l.expiry_date LIMIT 20`),
    query(`SELECT p.*, i.name AS product, i.unit, u.full_name AS by_name FROM productions p
           JOIN items i ON i.id=p.product_id JOIN users u ON u.id=p.created_by
           ORDER BY p.created_at DESC LIMIT 10`),
    query(`SELECT
             (SELECT COALESCE(SUM(qty_good),0) FROM productions WHERE status='registrada' AND kind='ENVASADO' AND production_date=CURRENT_DATE) AS today_units,
             (SELECT COUNT(*) FROM productions WHERE status='registrada' AND kind='PREPARACION' AND production_date=CURRENT_DATE) AS today_preps,
             (SELECT COALESCE(SUM(qty_good),0) FROM productions WHERE status='registrada' AND kind='ENVASADO' AND production_date >= date_trunc('month', CURRENT_DATE)) AS month_units,
             (SELECT COALESCE(SUM(stock_value),0) FROM v_item_stock WHERE type IN ('MP','ENV')) AS mp_value`),
    query(`SELECT l.*, i.name, i.unit, b.name AS brand FROM v_lot_stock l JOIN items i ON i.id=l.item_id
           LEFT JOIN brands b ON b.id=i.brand_id WHERE i.type='PP' AND l.qty > 0 ORDER BY l.received_at LIMIT 20`),
  ]);
  res.render('dashboard', { title: 'Panel', low: low.rows, expiring: expiring.rows, recent: recent.rows, kpi: kpi.rows[0], bulkLots: bulkLots.rows });
});

// ---------------------------------------------------------------- Inventario (lectura para todos)
router.get('/inventario', async (req, res) => {
  const { type = '', q = '' } = req.query;
  const { rows } = await query(
    `SELECT s.*, b.name AS brand FROM v_item_stock s LEFT JOIN brands b ON b.id=s.brand_id
     WHERE s.active AND ($1='' OR s.type=$1)
     AND ($2='' OR s.code ILIKE '%'||$2||'%' OR s.name ILIKE '%'||$2||'%' OR b.name ILIKE '%'||$2||'%')
     ORDER BY CASE s.type WHEN 'MP' THEN 0 WHEN 'ENV' THEN 1 WHEN 'PP' THEN 2 ELSE 3 END, s.name`, [type, q]);
  if (req.query.csv) {
    return toCSV(res, 'inventario.csv', ['Código', 'Artículo', 'Marca', 'Tipo', 'Unidad', 'Stock', 'Mínimo', 'Valor RD$'],
      rows.map((r) => [r.code, r.name, r.brand, r.type, r.unit, r.stock, r.min_stock, r.stock_value]));
  }
  res.render('inventory', { title: 'Inventario', items: rows, type, q });
});

router.get('/inventario/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [item] } = await query(
    `SELECT s.*, b.name AS brand, bk.name AS bulk_name, bk.unit AS bulk_unit FROM v_item_stock s
     LEFT JOIN brands b ON b.id=s.brand_id LEFT JOIN items bk ON bk.id=s.bulk_id WHERE s.id=$1`, [id]);
  if (!item) return res.status(404).render('error', { title: 'No encontrado', message: 'Artículo no existe' });
  const [lots, kardex, usedIn, recipe] = await Promise.all([
    query('SELECT * FROM v_lot_stock WHERE item_id=$1 AND qty <> 0 ORDER BY expiry_date NULLS LAST, received_at', [id]),
    query(`SELECT m.*, l.lot_code, u.full_name AS by_name,
             SUM(m.qty) OVER (ORDER BY m.created_at, m.id) AS balance
           FROM movements m JOIN lots l ON l.id=m.lot_id JOIN users u ON u.id=m.user_id
           WHERE m.item_id=$1 ORDER BY m.created_at DESC, m.id DESC LIMIT 300`, [id]),
    query(`SELECT r.*, i.code, i.name, i.type FROM recipe_lines r JOIN items i ON i.id=r.product_id WHERE r.component_id=$1 ORDER BY i.name`, [id]),
    ['PP', 'PT'].includes(item.type) ? inv.getRecipe(id) : Promise.resolve([]),
  ]);
  if (req.query.csv) {
    return toCSV(res, `kardex-${item.code}.csv`, ['Fecha', 'Tipo', 'Lote', 'Cantidad', 'Saldo', 'Costo unit.', 'Usuario', 'Nota'],
      kardex.rows.map((m) => [m.created_at.toISOString(), m.mtype, m.lot_code, m.qty, m.balance, m.unit_cost, m.by_name, m.notes]));
  }
  res.render('item', { title: item.name, item, lots: lots.rows, kardex: kardex.rows, usedIn: usedIn.rows, recipe, cap: inv.capacity(recipe) });
});

// ---------------------------------------------------------------- Detalle de preparación / envasado
router.get('/produccion/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [p] } = await query(
    `SELECT p.*, i.name AS product, i.code AS product_code, i.unit, b.name AS brand,
       u.full_name AS by_name, ua.full_name AS annulled_name,
       bl.lot_code AS bulk_lot_code, bp.id AS bulk_prep_id, bi.name AS bulk_name
     FROM productions p JOIN items i ON i.id=p.product_id JOIN users u ON u.id=p.created_by
     LEFT JOIN brands b ON b.id=i.brand_id
     LEFT JOIN users ua ON ua.id=p.annulled_by
     LEFT JOIN lots bl ON bl.id=p.bulk_lot_id LEFT JOIN productions bp ON bp.id=bl.production_id
     LEFT JOIN items bi ON bi.id=bl.item_id
     WHERE p.id=$1`, [id]);
  if (!p) return res.status(404).render('error', { title: 'No encontrado', message: 'Registro no existe' });
  const { rows: cons } = await query(
    `SELECT c.*, i.code, i.name, i.unit, i.type FROM production_consumptions c JOIN items i ON i.id=c.component_id
     WHERE c.production_id=$1 ORDER BY CASE i.type WHEN 'PP' THEN 0 WHEN 'MP' THEN 1 ELSE 2 END, i.name`, [id]);
  const { rows: lots } = await query(
    `SELECT m.item_id, l.lot_code, -m.qty AS qty FROM movements m JOIN lots l ON l.id=m.lot_id
     WHERE m.ref_type='production' AND m.ref_id=$1 AND m.mtype='CONSUMO'`, [id]);
  // Trazabilidad: si es preparación, qué envasados usaron este lote
  const { rows: usedBy } = p.kind === 'PREPARACION' ? await query(
    `SELECT e.id, e.code, e.production_date, e.qty_good, e.status, i.name FROM productions e
     JOIN lots l ON l.id=e.bulk_lot_id JOIN items i ON i.id=e.product_id
     WHERE l.production_id=$1 ORDER BY e.production_date`, [id]) : { rows: [] };
  res.render('production', { title: `${p.kind === 'PREPARACION' ? 'Preparación' : 'Envasado'} ${p.code}`, p, cons, lots, usedBy, tolerance: inv.TOLERANCE });
});

module.exports = router;
