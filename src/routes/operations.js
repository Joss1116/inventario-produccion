const router = require('express').Router();
const { query } = require('../db');
const { requirePerm, requireLogin } = require('./guards');
const inv = require('../services/inventory');
const { num } = require('../services/catalog');
const { toCSV } = require('./csv');

const arr = (v) => [].concat(v ?? []);
const consumptionsFrom = (b) => arr(b.componentId).map((id, i) => ({ componentId: Number(id), actualQty: arr(b.actualQty)[i] }));
const monthStart = (res) => res.locals.today().slice(0, 8) + '01';

// Lista común de preparaciones / envasados
async function listProductions(req, res, kind, view) {
  const from = req.query.from || monthStart(res);
  const to = req.query.to || res.locals.today();
  const product = req.query.product || '';
  const { rows } = await query(
    `SELECT p.*, i.name AS product, i.code AS product_code, i.unit, u.full_name AS by_name, bl.lot_code AS bulk_lot
     FROM productions p JOIN items i ON i.id=p.product_id JOIN users u ON u.id=p.created_by
     LEFT JOIN lots bl ON bl.id=p.bulk_lot_id
     WHERE p.kind=$4 AND p.production_date BETWEEN $1 AND $2 AND ($3='' OR p.product_id::text=$3)
     ORDER BY p.production_date DESC, p.id DESC`, [from, to, product, kind]);
  const { rows: products } = await query(`SELECT id, code, name FROM items WHERE type=$1 AND active ORDER BY name`, [kind === 'PREPARACION' ? 'PP' : 'PT']);
  if (req.query.csv) {
    const prep = kind === 'PREPARACION';
    return toCSV(res, `${prep ? 'preparaciones' : 'envasados'}_${from}_${to}.csv`,
      prep ? ['Registro', 'Lote', 'Fecha', 'Producto', 'Planificado', 'Obtenido', 'Rendimiento %', 'Costo', 'Estado', 'Registró']
        : ['Registro', 'Lote', 'Envasado', 'Producto', 'Buenas', 'Rechazadas', 'Costo', 'Estado', 'Registró'],
      rows.map((p) => (prep
        ? [p.code, p.lot_code, p.production_date, p.product, p.planned_qty, p.qty_good, p.planned_qty ? (p.qty_good / p.planned_qty * 100).toFixed(2) : '', p.total_cost, p.status, p.by_name]
        : [p.code, p.lot_code, p.production_date, p.product, p.qty_good, p.qty_rejected, p.total_cost, p.status, p.by_name])));
  }
  res.render(view, { title: kind === 'PREPARACION' ? 'Preparaciones' : 'Envasados', rows, products, from, to, product });
}

// ================================================================ RECEPCIÓN (recepcionista)
router.get('/recepcion', requirePerm('recepcion'), async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, s.name AS supplier, u.full_name AS by_name,
       (SELECT COALESCE(SUM(qty*unit_cost),0) FROM movements m WHERE m.ref_type='purchase' AND m.ref_id=p.id AND m.mtype IN ('COMPRA','INICIAL')) AS total,
       (SELECT COUNT(*) FROM lots l WHERE l.purchase_id=p.id)::int AS lines
     FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id JOIN users u ON u.id=p.created_by
     ORDER BY p.purchase_date DESC, p.id DESC LIMIT 300`);
  res.render('purchases', { title: 'Recepción de materiales', rows });
});

router.get('/recepcion/nueva', requirePerm('recepcion'), async (req, res) => {
  const initial = req.query.inicial === '1' && req.session.user.role === 'admin';
  const types = initial ? ['MP', 'ENV', 'PP', 'PT'] : ['MP', 'ENV'];
  const { rows: items } = await query(
    `SELECT i.id, i.code, i.name, i.unit, i.type, i.packaging_type, b.name AS brand FROM items i LEFT JOIN brands b ON b.id=i.brand_id
     WHERE i.active AND i.type = ANY($1) ORDER BY CASE i.type WHEN 'MP' THEN 0 WHEN 'ENV' THEN 1 WHEN 'PP' THEN 2 ELSE 3 END, i.name`, [types]);
  const { rows: suppliers } = await query('SELECT name FROM suppliers ORDER BY name');
  res.render('purchase_form', { title: initial ? 'Carga de inventario inicial' : 'Registrar recepción', items, suppliers, initial });
});

router.post('/recepcion', requirePerm('recepcion'), async (req, res) => {
  const b = req.body;
  const lines = arr(b.itemId).map((id, i) => ({
    itemId: Number(id), qty: num(arr(b.qty)[i]), unitCost: num(arr(b.unitCost)[i]) || 0, lotCode: arr(b.lotCode)[i] || null, expiry: arr(b.expiry)[i] || null,
  })).filter((l) => l.itemId && l.qty > 0);
  const r = await inv.createPurchase(req.session.user, {
    docNumber: b.docNumber, supplier: b.supplier, date: b.date, notes: b.notes, initial: b.initial === '1', lines,
  });
  req.flash('ok', `Recepción ${r.code} registrada`);
  res.redirect(`/recepcion/${r.id}`);
});

router.get('/recepcion/:id', requirePerm('recepcion'), async (req, res) => {
  const { rows: [p] } = await query(
    `SELECT p.*, s.name AS supplier, u.full_name AS by_name FROM purchases p
     LEFT JOIN suppliers s ON s.id=p.supplier_id JOIN users u ON u.id=p.created_by WHERE p.id=$1`, [req.params.id]);
  if (!p) return res.redirect('/recepcion');
  const { rows: lots } = await query(
    `SELECT l.*, i.code, i.name, i.unit FROM v_lot_stock l JOIN items i ON i.id=l.item_id WHERE l.purchase_id=$1 ORDER BY l.id`, [p.id]);
  res.render('purchase', { title: `Recepción ${p.code}`, p, lots });
});

// ================================================================ PREPARACIÓN (químico)
router.get('/preparacion', requireLogin, (req, res) => listProductions(req, res, 'PREPARACION', 'preparations'));

router.get('/preparacion/nueva', requirePerm('preparacion'), async (req, res) => {
  const { rows: products } = await query(
    `SELECT i.id, i.code, i.name, i.unit, b.name AS brand, COUNT(r.id)::int AS lines FROM items i
     LEFT JOIN brands b ON b.id=i.brand_id LEFT JOIN recipe_lines r ON r.product_id=i.id
     WHERE i.type='PP' AND i.active GROUP BY i.id, b.name ORDER BY i.name, b.name`);
  const productId = Number(req.query.product || res.locals.form.productId) || null;
  const product = products.find((p) => p.id === productId) || null;
  const recipe = product ? await inv.getRecipe(productId) : [];
  res.render('preparation_new', { title: 'Registrar preparación', products, product, recipe, cap: inv.capacity(recipe), tolerance: inv.TOLERANCE });
});

router.post('/preparacion', requirePerm('preparacion'), async (req, res) => {
  const b = req.body;
  const r = await inv.registerPreparation(req.session.user, {
    productId: Number(b.productId), date: b.date, plannedQty: num(b.plannedQty), obtainedQty: b.obtainedQty === '' ? '' : num(b.obtainedQty),
    shift: b.shift, line: b.line, notes: b.notes, consumptions: consumptionsFrom(b),
  });
  req.flash('ok', `Preparación registrada (${r.code}). Lote ${r.lotCode}`);
  res.redirect(`/produccion/${r.id}`);
});

// ================================================================ ENVASADO (envasador)
router.get('/envasado', requireLogin, (req, res) => listProductions(req, res, 'ENVASADO', 'packagings'));

router.get('/envasado/nuevo', requirePerm('envasado'), async (req, res) => {
  const { rows: products } = await query(
    `SELECT i.id, i.code, i.name, i.bulk_id, COUNT(r.id)::int AS lines FROM items i
     LEFT JOIN recipe_lines r ON r.product_id=i.id WHERE i.type='PT' AND i.active GROUP BY i.id ORDER BY i.name`);
  const productId = Number(req.query.product || res.locals.form.productId) || null;
  const product = products.find((p) => p.id === productId) || null;
  let recipe = []; let lots = [];
  if (product) {
    recipe = await inv.getRecipe(productId);
    ({ rows: lots } = await query(
      `SELECT l.*, COALESCE(p.elaboration_date::text, to_char(l.received_at,'YYYY-MM-DD')) AS elab
       FROM v_lot_stock l LEFT JOIN productions p ON p.id=l.production_id
       WHERE l.item_id=$1 AND l.qty > 0 ORDER BY l.received_at, l.id`, [product.bulk_id]));
  }
  res.render('packaging_new', { title: 'Registrar envasado', products, product, recipe, lots, cap: inv.capacity(recipe), tolerance: inv.TOLERANCE });
});

router.post('/envasado', requirePerm('envasado'), async (req, res) => {
  const b = req.body;
  const r = await inv.registerPackaging(req.session.user, {
    productId: Number(b.productId), bulkLotId: Number(b.bulkLotId), date: b.date || res.locals.today(),
    qtyGood: num(b.qtyGood), qtyRejected: num(b.qtyRejected) || 0, shift: b.shift, line: b.line, notes: b.notes,
    consumptions: consumptionsFrom(b),
  });
  req.flash('ok', `Envasado registrado (${r.code}). Lote ${r.lotCode}`);
  res.redirect(`/produccion/${r.id}`);
});

module.exports = router;
