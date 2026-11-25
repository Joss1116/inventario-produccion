const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { requireAdmin } = require('./guards');
const inv = require('../services/inventory');
const { toCSV } = require('./csv');
const { ROLES } = require('../services/perms');

router.use(requireAdmin);
const arr = (v) => [].concat(v ?? []);
const num = (v) => (v === '' || v === undefined || v === null ? null : Number(String(v).replace(',', '.')));

// ---------------------------------------------------------------- Anular recepción
router.post('/recepcion/:id/anular', async (req, res) => {
  await inv.annulPurchase(req.session.user, Number(req.params.id), (req.body.reason || '').trim());
  req.flash('ok', 'Recepción anulada; el inventario fue revertido');
  res.redirect(`/recepcion/${req.params.id}`);
});

// ---------------------------------------------------------------- Anular producción
router.post('/produccion/:id/anular', async (req, res) => {
  await inv.annulProduction(req.session.user, Number(req.params.id), (req.body.reason || '').trim());
  req.flash('ok', 'Registro anulado; los materiales volvieron a sus lotes');
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
  const { rows: preps } = await query(
    `SELECT i.id, i.code, i.name, i.unit, b.name AS brand, COUNT(*)::int AS batches,
       SUM(p.planned_qty) AS planned, SUM(p.qty_good) AS obtained, SUM(p.total_cost) AS cost
     FROM productions p JOIN items i ON i.id=p.product_id LEFT JOIN brands b ON b.id=i.brand_id
     WHERE p.status='registrada' AND p.kind='PREPARACION' AND p.production_date BETWEEN $1 AND $2
     GROUP BY i.id, b.name ORDER BY i.name`, [from, to]);
  const { rows: packs } = await query(
    `SELECT i.id, i.code, i.name, COUNT(*)::int AS batches,
       SUM(p.qty_good) AS good, SUM(p.qty_rejected) AS rejected, SUM(p.total_cost) AS cost
     FROM productions p JOIN items i ON i.id=p.product_id
     WHERE p.status='registrada' AND p.kind='ENVASADO' AND p.production_date BETWEEN $1 AND $2
     GROUP BY i.id ORDER BY i.name`, [from, to]);
  const { rows: byComponent } = await query(
    `SELECT p.kind, i.code, i.name, i.unit, i.type, SUM(c.theoretical_qty) AS theo, SUM(c.actual_qty) AS actual, SUM(c.cost) AS cost
     FROM production_consumptions c JOIN productions p ON p.id=c.production_id JOIN items i ON i.id=c.component_id
     WHERE p.status='registrada' AND p.production_date BETWEEN $1 AND $2
     GROUP BY p.kind, i.id ORDER BY p.kind DESC, i.type, i.name`, [from, to]);
  if (req.query.csv === 'consumo') {
    return toCSV(res, `consumo_${from}_${to}.csv`, ['Etapa', 'Código', 'Componente', 'Tipo', 'Unidad', 'Teórico', 'Real', 'Desviación', 'Desv %', 'Costo RD$'],
      byComponent.map((r) => [r.kind, r.code, r.name, r.type, r.unit, r.theo, r.actual, r.actual - r.theo, r.theo ? ((r.actual - r.theo) / r.theo * 100).toFixed(2) : '', r.cost]));
  }
  res.render('admin/reports', { title: 'Reportes de producción', from, to, preps, packs, byComponent, tolerance: inv.TOLERANCE });
});

// ---------------------------------------------------------------- Usuarios
router.get('/usuarios', async (req, res) => {
  const { rows } = await query('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY active DESC, role, full_name');
  res.render('admin/users', { title: 'Usuarios', rows });
});

router.post('/usuarios', async (req, res) => {
  const b = req.body;
  if (!b.username?.trim() || !b.full_name?.trim()) throw new inv.AppError('Usuario y nombre son obligatorios');
  if (!Object.keys(ROLES).includes(b.role)) throw new inv.AppError('Rol inválido');
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
