const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, tx } = require('../db');
const { requireAdmin } = require('./guards');
const inv = require('../services/inventory');
const { toCSV } = require('./csv');

router.use(requireAdmin);
const arr = (v) => [].concat(v ?? []);
const num = (v) => (v === '' || v === undefined || v === null ? null : Number(String(v).replace(',', '.')));

// ---------------------------------------------------------------- Artículos
router.get('/articulos', async (req, res) => {
  const { rows } = await query('SELECT * FROM v_item_stock ORDER BY active DESC, type, name');
  res.render('admin/items', { title: 'Artículos', items: rows });
});

router.get('/articulos/nuevo', (req, res) => res.render('admin/item_form', { title: 'Nuevo artículo', item: { type: req.query.type || 'MP', ...res.locals.form } }));
router.get('/articulos/:id', async (req, res) => {
  const { rows: [item] } = await query('SELECT * FROM items WHERE id=$1', [req.params.id]);
  res.render('admin/item_form', { title: 'Editar artículo', item });
});

router.post('/articulos', async (req, res) => {
  const b = req.body;
  if (!b.code?.trim() || !b.name?.trim() || !b.unit?.trim()) throw new inv.AppError('Código, nombre y unidad son obligatorios');
  if (b.id) {
    await query('UPDATE items SET code=$2, name=$3, type=$4, unit=$5, min_stock=$6, notes=$7, active=$8 WHERE id=$1',
      [b.id, b.code.trim().toUpperCase(), b.name.trim(), b.type, b.unit.trim(), num(b.min_stock) || 0, b.notes || null, b.active === 'on']);
  } else {
    await query('INSERT INTO items(code, name, type, unit, min_stock, notes) VALUES ($1,$2,$3,$4,$5,$6)',
      [b.code.trim().toUpperCase(), b.name.trim(), b.type, b.unit.trim(), num(b.min_stock) || 0, b.notes || null]);
  }
  req.flash('ok', 'Artículo guardado');
  res.redirect('/admin/articulos');
});

// ---------------------------------------------------------------- Fórmulas (BOM)
router.get('/formulas', async (req, res) => {
  const { rows } = await query(
    `SELECT i.*, COUNT(r.id)::int AS lines FROM items i LEFT JOIN recipe_lines r ON r.product_id=i.id
     WHERE i.type='PT' GROUP BY i.id ORDER BY i.active DESC, i.name`);
  res.render('admin/recipes', { title: 'Fórmulas', products: rows });
});

router.get('/formulas/:id', async (req, res) => {
  const { rows: [product] } = await query("SELECT * FROM items WHERE id=$1 AND type='PT'", [req.params.id]);
  if (!product) return res.redirect('/admin/formulas');
  const recipe = await inv.getRecipe(product.id);
  const { rows: components } = await query("SELECT id, code, name, unit, type FROM items WHERE type IN ('MP','ENV') AND active ORDER BY type, name");
  res.render('admin/recipe_form', { title: `Fórmula: ${product.name}`, product, recipe, components, cap: inv.capacity(recipe) });
});

router.post('/formulas/:id', async (req, res) => {
  const pid = Number(req.params.id);
  const comps = arr(req.body.componentId); const qtys = arr(req.body.qty); const waste = arr(req.body.waste);
  const lines = comps.map((c, i) => ({ c: Number(c), q: num(qtys[i]), w: num(waste[i]) || 0 })).filter((l) => l.c && l.q > 0);
  if (new Set(lines.map((l) => l.c)).size !== lines.length) throw new inv.AppError('Un componente aparece repetido en la fórmula');
  await tx(async (c) => {
    await c.query('DELETE FROM recipe_lines WHERE product_id=$1', [pid]);
    for (const l of lines) {
      await c.query('INSERT INTO recipe_lines(product_id, component_id, qty_per_unit, waste_pct) VALUES ($1,$2,$3,$4)', [pid, l.c, l.q, l.w]);
    }
  });
  req.flash('ok', `Fórmula guardada (${lines.length} componentes)`);
  res.redirect(`/admin/formulas/${pid}`);
});

// ---------------------------------------------------------------- Compras / entradas
router.get('/compras', async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, s.name AS supplier, u.full_name AS by_name,
       (SELECT COALESCE(SUM(qty*unit_cost),0) FROM movements m WHERE m.ref_type='purchase' AND m.ref_id=p.id AND m.mtype IN ('COMPRA','INICIAL')) AS total,
       (SELECT COUNT(*) FROM lots l WHERE l.purchase_id=p.id)::int AS lines
     FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id JOIN users u ON u.id=p.created_by
     ORDER BY p.purchase_date DESC, p.id DESC LIMIT 300`);
  res.render('admin/purchases', { title: 'Compras y entradas', rows });
});

router.get('/compras/nueva', async (req, res) => {
  const { rows: items } = await query('SELECT id, code, name, unit, type FROM items WHERE active ORDER BY type, name');
  const { rows: suppliers } = await query('SELECT name FROM suppliers ORDER BY name');
  res.render('admin/purchase_form', { title: 'Registrar compra / entrada', items, suppliers });
});

router.post('/compras', async (req, res) => {
  const b = req.body;
  const ids = arr(b.itemId); const q = arr(b.qty); const cost = arr(b.unitCost); const lot = arr(b.lotCode); const exp = arr(b.expiry);
  const lines = ids.map((id, i) => ({ itemId: Number(id), qty: num(q[i]), unitCost: num(cost[i]) || 0, lotCode: lot[i] || null, expiry: exp[i] || null }))
    .filter((l) => l.itemId && l.qty > 0);
  const id = await inv.createPurchase(req.session.user, {
    docNumber: b.docNumber, supplier: b.supplier, date: b.date, notes: b.notes, initial: b.initial === 'on', lines,
  });
  req.flash('ok', 'Entrada registrada');
  res.redirect(`/admin/compras/${id}`);
});

router.get('/compras/:id', async (req, res) => {
  const { rows: [p] } = await query(
    `SELECT p.*, s.name AS supplier, u.full_name AS by_name FROM purchases p
     LEFT JOIN suppliers s ON s.id=p.supplier_id JOIN users u ON u.id=p.created_by WHERE p.id=$1`, [req.params.id]);
  if (!p) return res.redirect('/admin/compras');
  const { rows: lots } = await query(
    `SELECT l.*, i.code, i.name, i.unit FROM v_lot_stock l JOIN items i ON i.id=l.item_id WHERE l.purchase_id=$1 ORDER BY l.id`, [p.id]);
  res.render('admin/purchase', { title: `Entrada #${p.id}`, p, lots });
});

router.post('/compras/:id/anular', async (req, res) => {
  await inv.annulPurchase(req.session.user, Number(req.params.id), (req.body.reason || '').trim());
  req.flash('ok', 'Entrada anulada; el inventario fue revertido');
  res.redirect(`/admin/compras/${req.params.id}`);
});

// ---------------------------------------------------------------- Anular producción
router.post('/produccion/:id/anular', async (req, res) => {
  await inv.annulProduction(req.session.user, Number(req.params.id), (req.body.reason || '').trim());
  req.flash('ok', 'Producción anulada; consumos devueltos al inventario');
  res.redirect(`/produccion/${req.params.id}`);
});

// ---------------------------------------------------------------- Salidas
router.get('/salidas', async (req, res) => {
  const { rows } = await query(
    `SELECT d.*, i.code, i.name, i.unit, u.full_name AS by_name FROM dispatches d
     JOIN items i ON i.id=d.item_id JOIN users u ON u.id=d.created_by ORDER BY d.created_at DESC LIMIT 300`);
  const { rows: items } = await query('SELECT id, code, name, unit, type, stock FROM v_item_stock WHERE active AND stock > 0 ORDER BY type DESC, name');
  res.render('admin/dispatches', { title: 'Salidas / despachos', rows, items });
});

router.post('/salidas', async (req, res) => {
  const b = req.body;
  await inv.createDispatch(req.session.user, { itemId: Number(b.itemId), qty: num(b.qty), destination: b.destination, docNumber: b.docNumber, notes: b.notes });
  req.flash('ok', 'Salida registrada');
  res.redirect('/admin/salidas');
});

// ---------------------------------------------------------------- Ajustes (conteo físico)
router.get('/ajustes', async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, i.code, i.name, i.unit, u.full_name AS by_name FROM adjustments a
     JOIN items i ON i.id=a.item_id JOIN users u ON u.id=a.created_by ORDER BY a.created_at DESC LIMIT 300`);
  const { rows: items } = await query('SELECT id, code, name, unit, type, stock FROM v_item_stock WHERE active ORDER BY type, name');
  res.render('admin/adjustments', { title: 'Ajustes por conteo físico', rows, items });
});

router.post('/ajustes', async (req, res) => {
  const r = await inv.createAdjustment(req.session.user, { itemId: Number(req.body.itemId), countedQty: num(req.body.countedQty), reason: req.body.reason });
  req.flash('ok', `Ajuste aplicado (${r.diff > 0 ? '+' : ''}${r.diff})`);
  res.redirect('/admin/ajustes');
});

// ---------------------------------------------------------------- Reportes
router.get('/reportes', async (req, res) => {
  const from = req.query.from || res.locals.today().slice(0, 8) + '01';
  const to = req.query.to || res.locals.today();
  const { rows: byProduct } = await query(
    `SELECT i.id, i.code, i.name, i.unit, COUNT(*)::int AS batches,
       SUM(p.qty_good) AS good, SUM(p.qty_rejected) AS rejected, SUM(p.total_cost) AS cost
     FROM productions p JOIN items i ON i.id=p.product_id
     WHERE p.status='registrada' AND p.production_date BETWEEN $1 AND $2
     GROUP BY i.id ORDER BY i.name`, [from, to]);
  const { rows: byComponent } = await query(
    `SELECT i.code, i.name, i.unit, i.type, SUM(c.theoretical_qty) AS theo, SUM(c.actual_qty) AS actual, SUM(c.cost) AS cost
     FROM production_consumptions c JOIN productions p ON p.id=c.production_id JOIN items i ON i.id=c.component_id
     WHERE p.status='registrada' AND p.production_date BETWEEN $1 AND $2
     GROUP BY i.id ORDER BY i.type, i.name`, [from, to]);
  if (req.query.csv === 'consumo') {
    return toCSV(res, `consumo_${from}_${to}.csv`, ['Código', 'Componente', 'Tipo', 'Unidad', 'Teórico', 'Real', 'Desviación', 'Desv %', 'Costo RD$'],
      byComponent.map((r) => [r.code, r.name, r.type, r.unit, r.theo, r.actual, r.actual - r.theo, r.theo ? ((r.actual - r.theo) / r.theo * 100).toFixed(2) : '', r.cost]));
  }
  res.render('admin/reports', { title: 'Reportes de producción', from, to, byProduct, byComponent, tolerance: inv.TOLERANCE });
});

// ---------------------------------------------------------------- Usuarios
router.get('/usuarios', async (req, res) => {
  const { rows } = await query('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY active DESC, role, full_name');
  res.render('admin/users', { title: 'Usuarios', rows });
});

router.post('/usuarios', async (req, res) => {
  const b = req.body;
  if (!b.username?.trim() || !b.full_name?.trim()) throw new inv.AppError('Usuario y nombre son obligatorios');
  if (!['admin', 'operador'].includes(b.role)) throw new inv.AppError('Rol inválido');
  if (b.password && b.password.length < 8) throw new inv.AppError('La contraseña debe tener al menos 8 caracteres');
  if (b.id) {
    if (Number(b.id) === req.session.user.id && (b.role !== 'admin' || b.active !== 'on')) throw new inv.AppError('No puedes quitarte el rol de administrador ni desactivarte');
    await query('UPDATE users SET full_name=$2, role=$3, active=$4 WHERE id=$1', [b.id, b.full_name.trim(), b.role, b.active === 'on']);
    if (b.password) await query('UPDATE users SET password_hash=$2 WHERE id=$1', [b.id, bcrypt.hashSync(b.password, 10)]);
  } else {
    if (!b.password) throw new inv.AppError('Asigna una contraseña');
    await query('INSERT INTO users(username, full_name, role, password_hash) VALUES ($1,$2,$3,$4)',
      [b.username.trim().toLowerCase(), b.full_name.trim(), b.role, bcrypt.hashSync(b.password, 10)]);
  }
  req.flash('ok', 'Usuario guardado');
  res.redirect('/admin/usuarios');
});

module.exports = router;
