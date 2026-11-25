const router = require('express').Router();
const { query } = require('../db');
const { requireLogin, requireAdmin, requirePerm, deny } = require('./guards');
const { can, editableTypes } = require('../services/perms');
const inv = require('../services/inventory');
const cat = require('../services/catalog');

router.use(requireLogin);
const arr = (v) => [].concat(v ?? []);
const linesFrom = (b) => arr(b.componentId).map((c, i) => ({ c: Number(c), q: cat.num(arr(b.qty)[i]), w: cat.num(arr(b.waste)[i]) || 0 }));

// ---------------------------------------------------------------- Artículos (MP, ENV, PP)
router.get('/articulos', async (req, res) => {
  const types = editableTypes(req.session.user.role);
  if (!types.length) return deny(res);
  const items = await cat.listItems(types);
  res.render('catalog/items', { title: 'Artículos', items, types });
});

router.get('/articulos/nuevo', async (req, res) => {
  const type = req.query.type;
  if (type === 'PT') return res.redirect('/catalogo/presentaciones/nueva');
  if (!can(req.session.user.role, `items.${type}`)) return deny(res);
  const { rows: brands } = await query('SELECT name FROM brands WHERE active ORDER BY name');
  res.render('catalog/item_form', { title: 'Nuevo artículo', item: { type, ...res.locals.form }, brands, PACKAGING_TYPES: cat.PACKAGING_TYPES });
});

router.get('/articulos/:id', async (req, res) => {
  const { rows: [item] } = await query('SELECT i.*, b.name AS brand FROM items i LEFT JOIN brands b ON b.id=i.brand_id WHERE i.id=$1', [req.params.id]);
  if (!item) return res.redirect('/catalogo/articulos');
  if (item.type === 'PT') return res.redirect(`/catalogo/presentaciones/${item.id}`);
  if (!can(req.session.user.role, `items.${item.type}`)) return deny(res);
  const { rows: brands } = await query('SELECT name FROM brands WHERE active ORDER BY name');
  res.render('catalog/item_form', { title: `Editar ${item.code}`, item, brands, PACKAGING_TYPES: cat.PACKAGING_TYPES });
});

router.post('/articulos', async (req, res) => {
  if (!can(req.session.user.role, `items.${req.body.type}`)) return deny(res);
  const r = await cat.saveItem(req.body);
  if (r.code) {
    req.flash('ok', `Artículo creado con código ${r.code}`);
    if (req.body.type === 'PP' && can(req.session.user.role, 'formulas')) return res.redirect(`/catalogo/formulas/${r.id}`);
  } else req.flash('ok', 'Artículo actualizado');
  res.redirect('/catalogo/articulos');
});

// ---------------------------------------------------------------- Marcas
router.get('/marcas', requirePerm('marcas'), async (req, res) => {
  const { rows } = await query(
    `SELECT b.*, COUNT(i.id)::int AS products FROM brands b LEFT JOIN items i ON i.brand_id=b.id GROUP BY b.id ORDER BY b.active DESC, b.name`);
  res.render('catalog/brands', { title: 'Marcas', rows });
});

router.post('/marcas', requirePerm('marcas'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) throw new inv.AppError('Escribe el nombre de la marca');
  if (req.body.id) await query('UPDATE brands SET name=$2, active=$3 WHERE id=$1', [req.body.id, name, req.body.active === 'on']);
  else await query('INSERT INTO brands(name) VALUES ($1)', [name]);
  req.flash('ok', 'Marca guardada');
  res.redirect('/catalogo/marcas');
});

// ---------------------------------------------------------------- Fórmulas de preparación (PP)
router.get('/formulas', requirePerm('formulas', 'preparacion'), async (req, res) => {
  const { rows } = await query(
    `SELECT i.*, b.name AS brand, COUNT(r.id)::int AS lines FROM items i LEFT JOIN brands b ON b.id=i.brand_id
     LEFT JOIN recipe_lines r ON r.product_id=i.id WHERE i.type='PP' GROUP BY i.id, b.name ORDER BY i.active DESC, i.name`);
  res.render('catalog/formulas', { title: 'Fórmulas de preparación', products: rows });
});

router.get('/formulas/:id', requirePerm('formulas', 'preparacion'), async (req, res) => {
  const { rows: [product] } = await query("SELECT i.*, b.name AS brand FROM items i LEFT JOIN brands b ON b.id=i.brand_id WHERE i.id=$1 AND i.type='PP'", [req.params.id]);
  if (!product) return res.redirect('/catalogo/formulas');
  const recipe = await inv.getRecipe(product.id);
  const { rows: components } = await query("SELECT id, code, name, unit FROM items WHERE type='MP' AND active ORDER BY name");
  res.render('catalog/formula_form', { title: `Fórmula: ${product.name}`, product, recipe, components, cap: inv.capacity(recipe), editable: can(req.session.user.role, 'formulas') });
});

router.post('/formulas/:id', requirePerm('formulas'), async (req, res) => {
  const n = await cat.savePPFormula(Number(req.params.id), linesFrom(req.body));
  req.flash('ok', `Fórmula guardada (${n} materias primas)`);
  res.redirect(`/catalogo/formulas/${req.params.id}`);
});

// ---------------------------------------------------------------- Productos terminados (presentaciones)
router.get('/presentaciones', requireAdmin, async (req, res) => {
  const items = await cat.listItems(['PT']);
  res.render('catalog/presentations', { title: 'Productos terminados', items });
});

async function ptForm(req, res, item, recipe) {
  const { rows: bulks } = await query(
    "SELECT i.id, i.code, i.name, i.unit, b.name AS brand FROM items i LEFT JOIN brands b ON b.id=i.brand_id WHERE i.type='PP' AND i.active ORDER BY i.name");
  const { rows: envs } = await query("SELECT id, code, name, unit, packaging_type, capacity, capacity_unit FROM items WHERE type='ENV' AND active ORDER BY packaging_type, name");
  const bulkLine = recipe.find((r) => r.type === 'PP');
  res.render('catalog/presentation_form', {
    title: item.id ? `Editar ${item.code}` : 'Nuevo producto terminado', item, bulks, envs,
    bulkLine, envLines: recipe.filter((r) => r.type === 'ENV'),
  });
}

router.get('/presentaciones/nueva', requireAdmin, (req, res) => ptForm(req, res, { ...res.locals.form }, []));
router.get('/presentaciones/:id', requireAdmin, async (req, res) => {
  const { rows: [item] } = await query("SELECT * FROM items WHERE id=$1 AND type='PT'", [req.params.id]);
  if (!item) return res.redirect('/catalogo/presentaciones');
  ptForm(req, res, item, await inv.getRecipe(item.id));
});

router.post('/presentaciones', requireAdmin, async (req, res) => {
  const r = await cat.savePT(req.body, linesFrom(req.body));
  req.flash('ok', `Producto terminado guardado: ${r.name}`);
  res.redirect('/catalogo/presentaciones');
});

module.exports = router;
