// Núcleo de la lógica de inventario: lotes, FIFO/FEFO, producción, reversos.
const { query, tx } = require('../db');
const { nextCode } = require('./codes');

class AppError extends Error {}

const round4 = (n) => Math.round(n * 10000) / 10000;
const TOLERANCE = parseFloat(process.env.VARIANCE_TOLERANCE_PCT || '5');

// Bloqueo por artículo dentro de la transacción (orden fijo => sin deadlocks)
async function lockItems(c, ids) {
  const uniq = [...new Set(ids.map(Number))].sort((a, b) => a - b);
  for (const id of uniq) await c.query('SELECT pg_advisory_xact_lock(1, $1)', [id]);
}

async function itemStock(c, itemId) {
  const { rows } = await c.query('SELECT COALESCE(SUM(qty),0) AS q FROM movements WHERE item_id=$1', [itemId]);
  return Number(rows[0].q);
}

async function getItem(c, id) {
  const { rows } = await c.query('SELECT * FROM items WHERE id=$1', [id]);
  if (!rows[0]) throw new AppError('Artículo no encontrado');
  return rows[0];
}

// Lotes con saldo, en orden FEFO (vence primero) y luego FIFO (entró primero)
async function availableLots(c, itemId) {
  const { rows } = await c.query(
    `SELECT * FROM v_lot_stock WHERE item_id=$1 AND qty > 0
     ORDER BY expiry_date NULLS LAST, received_at, id`, [itemId]);
  return rows;
}

async function addLot(c, o) {
  const { rows } = await c.query(
    `INSERT INTO lots(item_id, lot_code, source, purchase_id, production_id, expiry_date, unit_cost, initial_qty)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [o.itemId, o.lotCode, o.source, o.purchaseId || null, o.productionId || null,
      o.expiry || null, o.unitCost || 0, o.qty]);
  const lotId = rows[0].id;
  await c.query(
    `INSERT INTO movements(item_id, lot_id, mtype, qty, unit_cost, ref_type, ref_id, notes, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [o.itemId, lotId, o.mtype, o.qty, o.unitCost || 0, o.refType, o.refId, o.notes || null, o.userId]);
  return lotId;
}

// Descarga una cantidad recorriendo lotes FEFO/FIFO. Devuelve costo total.
async function consume(c, o) {
  let pending = round4(o.qty);
  if (pending <= 0) return { cost: 0, parts: [] };
  const lots = await availableLots(c, o.itemId);
  const total = lots.reduce((s, l) => s + l.qty, 0);
  if (total + 1e-9 < pending) {
    const it = await getItem(c, o.itemId);
    throw new AppError(`Stock insuficiente de ${it.code} – ${it.name}: disponible ${round4(total)} ${it.unit}, requerido ${pending} ${it.unit}`);
  }
  let cost = 0;
  const parts = [];
  for (const l of lots) {
    if (pending <= 0) break;
    const take = round4(Math.min(l.qty, pending));
    await c.query(
      `INSERT INTO movements(item_id, lot_id, mtype, qty, unit_cost, ref_type, ref_id, notes, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [o.itemId, l.id, o.mtype, -take, l.unit_cost, o.refType, o.refId, o.notes || null, o.userId]);
    cost += take * l.unit_cost;
    parts.push({ lotId: l.id, lotCode: l.lot_code, qty: take });
    pending = round4(pending - take);
  }
  return { cost, parts };
}

// Revierte todos los movimientos de un documento. Exige que lo que entró siga disponible.
async function reverseRef(c, refType, refId, userId, notes) {
  const { rows: movs } = await c.query(
    `SELECT * FROM movements WHERE ref_type=$1 AND ref_id=$2 AND mtype <> 'ANULACION'`, [refType, refId]);
  await lockItems(c, movs.map((m) => m.item_id));
  for (const m of movs.filter((x) => x.qty > 0)) {
    const { rows } = await c.query('SELECT qty, lot_code FROM v_lot_stock WHERE id=$1', [m.lot_id]);
    if (rows[0].qty + 1e-9 < m.qty) {
      const it = await getItem(c, m.item_id);
      throw new AppError(`No se puede anular: del lote ${rows[0].lot_code} (${it.name}) ya se usaron/despacharon unidades. Saldo ${rows[0].qty}, ingresado ${m.qty}.`);
    }
  }
  for (const m of movs) {
    await c.query(
      `INSERT INTO movements(item_id, lot_id, mtype, qty, unit_cost, ref_type, ref_id, notes, user_id)
       VALUES ($1,$2,'ANULACION',$3,$4,$5,$6,$7,$8)`,
      [m.item_id, m.lot_id, -m.qty, m.unit_cost, refType, refId, notes, userId]);
  }
}

// ---------------------------------------------------------------- Fórmulas
async function getRecipe(productId, c = { query }) {
  const { rows } = await c.query(
    `SELECT r.*, i.code, i.name, i.unit, i.type, i.packaging_type, COALESCE(s.stock,0) AS stock
     FROM recipe_lines r JOIN items i ON i.id=r.component_id
     LEFT JOIN v_item_stock s ON s.id=i.id
     WHERE r.product_id=$1
     ORDER BY CASE i.type WHEN 'PP' THEN 0 WHEN 'MP' THEN 1 ELSE 2 END, i.packaging_type NULLS LAST, i.name`, [productId]);
  return rows;
}

// Capacidad: cuántas unidades se pueden producir con el stock actual (cuello de botella)
function capacity(recipe) {
  if (!recipe.length) return { max: 0, bottleneck: null };
  let max = Infinity; let bottleneck = null;
  for (const r of recipe) {
    const per = r.qty_per_unit * (1 + r.waste_pct / 100);
    const can = Math.floor(r.stock / per + 1e-9);
    if (can < max) { max = can; bottleneck = r; }
  }
  return { max, bottleneck };
}

// ---------------------------------------------------------------- Recepción (compras / entradas)
async function createPurchase(user, p) {
  if (!p.lines.length) throw new AppError('Agrega al menos una línea con artículo y cantidad');
  if (p.initial && user.role !== 'admin') throw new AppError('Solo el administrador puede cargar inventario inicial');
  return tx(async (c) => {
    let supplierId = null;
    if (p.supplier && p.supplier.trim()) {
      const { rows } = await c.query(
        `INSERT INTO suppliers(name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [p.supplier.trim()]);
      supplierId = rows[0].id;
    }
    const code = await nextCode(c, 'REC', 6);
    const { rows } = await c.query(
      `INSERT INTO purchases(code, doc_number, supplier_id, purchase_date, notes, is_initial, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [code, p.docNumber || null, supplierId, p.date, p.notes || null, !!p.initial, user.id]);
    const pid = rows[0].id;
    await lockItems(c, p.lines.map((l) => l.itemId));
    for (const l of p.lines) {
      const it = await getItem(c, l.itemId);
      if (!it.active) throw new AppError(`${it.name} está inactivo`);
      if (!p.initial && !['MP', 'ENV'].includes(it.type)) {
        throw new AppError(`${it.name} no entra por recepción: el producto preparado sale de Preparación y el terminado de Envasado`);
      }
      const kind = p.initial ? 'INICIAL' : 'COMPRA';
      await addLot(c, {
        itemId: l.itemId, lotCode: (l.lotCode || '').trim() || p.docNumber || code, source: kind,
        purchaseId: pid, expiry: l.expiry, unitCost: l.unitCost, qty: l.qty,
        mtype: kind, refType: 'purchase', refId: pid, userId: user.id, notes: code,
      });
    }
    return { id: pid, code };
  });
}

async function annulPurchase(user, id, reason) {
  if (!reason) throw new AppError('Indica el motivo de la anulación');
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM purchases WHERE id=$1 FOR UPDATE', [id]);
    if (!rows[0] || rows[0].status !== 'activa') throw new AppError('Recepción no encontrada o ya anulada');
    await reverseRef(c, 'purchase', id, user.id, `Anulación ${rows[0].code}: ${reason}`);
    await c.query(`UPDATE purchases SET status='anulada', annulled_by=$2, annulled_at=now(), annul_reason=$3 WHERE id=$1`,
      [id, user.id, reason]);
  });
}

// ---------------------------------------------------------------- Producción (común)
function theoretical(recipe, units) {
  return recipe.map((r) => ({
    componentId: r.component_id,
    type: r.type,
    qty: round4(r.qty_per_unit * units * (1 + r.waste_pct / 100)),
  }));
}

// Consumo real: si el usuario no lo corrige, se toma el teórico
function withActuals(theo, consumptions) {
  const m = new Map((consumptions || []).map((x) => [Number(x.componentId), x.actualQty]));
  return theo.map((t) => {
    const raw = m.get(t.componentId);
    const actual = raw === undefined || raw === '' || raw === null ? t.qty : round4(Number(raw));
    if (!(actual >= 0)) throw new AppError('Consumo real inválido');
    return { ...t, actual };
  });
}

const dev = (real, theo) => (theo > 0 ? Math.abs(real - theo) / theo * 100 : 0);

function requireNoteIfDeviation(count, notes) {
  if (count && !(notes || '').trim()) {
    throw new AppError(`Hay ${count} valor(es) con desviación mayor a ${TOLERANCE}% respecto a lo esperado. Escribe una observación que lo explique.`);
  }
}

async function nextProductionCode(c, kind, date) {
  await c.query('SELECT pg_advisory_xact_lock(2, 0)');
  const { rows } = await c.query('SELECT COUNT(*)::int AS n FROM productions WHERE kind=$1 AND production_date=$2', [kind, date]);
  const prefix = kind === 'PREPARACION' ? 'PREP' : 'ENVS';
  return `${prefix}-${date.replace(/-/g, '')}-${String(rows[0].n + 1).padStart(3, '0')}`;
}

async function insertProduction(c, f) {
  const { rows } = await c.query(
    `INSERT INTO productions(kind, code, product_id, qty_good, qty_rejected, planned_qty, production_date, elaboration_date,
       lot_code, bulk_lot_id, shift, line, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [f.kind, f.code, f.productId, f.good, f.rejected || 0, f.planned || null, f.date, f.elab, f.lotCode,
      f.bulkLotId || null, f.shift || null, f.line || null, f.notes || null, f.userId]);
  return rows[0].id;
}

async function saveConsumption(c, pid, l, cost) {
  await c.query(
    `INSERT INTO production_consumptions(production_id, component_id, theoretical_qty, actual_qty, cost) VALUES ($1,$2,$3,$4,$5)`,
    [pid, l.componentId, l.qty, l.actual, cost]);
}

// Descarga de un lote específico (el envasador elige qué lote de producto preparado usa)
async function consumeLot(c, o) {
  const qty = round4(o.qty);
  if (qty <= 0) return { cost: 0 };
  const { rows } = await c.query('SELECT * FROM v_lot_stock WHERE id=$1', [o.lotId]);
  const lot = rows[0];
  if (lot.qty + 1e-9 < qty) throw new AppError(`El lote ${lot.lot_code} solo tiene ${round4(lot.qty)} disponible; se requieren ${qty}`);
  await c.query(
    `INSERT INTO movements(item_id, lot_id, mtype, qty, unit_cost, ref_type, ref_id, notes, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [lot.item_id, lot.id, o.mtype, -qty, lot.unit_cost, o.refType, o.refId, o.notes || null, o.userId]);
  return { cost: qty * lot.unit_cost };
}

// ---------------------------------------------------------------- Preparación (químico)
// Materia prima => producto preparado a granel. Crea el lote = fecha de elaboración.
async function registerPreparation(user, p) {
  const planned = round4(Number(p.plannedQty) || 0);
  const obtained = round4(p.obtainedQty === '' || p.obtainedQty === undefined ? planned : Number(p.obtainedQty));
  if (!(planned > 0)) throw new AppError('Indica la cantidad a preparar');
  if (!(obtained > 0)) throw new AppError('Indica la cantidad obtenida');
  if (!p.date) throw new AppError('Indica la fecha de elaboración');

  return tx(async (c) => {
    const product = await getItem(c, p.productId);
    if (product.type !== 'PP') throw new AppError('Selecciona un producto preparado');
    const recipe = await getRecipe(p.productId, c);
    if (!recipe.length) throw new AppError(`${product.name} no tiene fórmula de preparación`);

    const lines = withActuals(theoretical(recipe, planned), p.consumptions);
    const off = lines.filter((l) => dev(l.actual, l.qty) > TOLERANCE).length + (dev(obtained, planned) > TOLERANCE ? 1 : 0);
    requireNoteIfDeviation(off, p.notes);

    const code = await nextProductionCode(c, 'PREPARACION', p.date);
    await lockItems(c, [p.productId, ...lines.map((l) => l.componentId)]);

    // Lote = fecha de elaboración (AAAAMMDD). Si ese día ya hubo otra preparación del mismo producto: -2, -3...
    const base = p.date.replace(/-/g, '');
    const { rows: same } = await c.query(
      `SELECT COUNT(*)::int AS n FROM productions WHERE kind='PREPARACION' AND product_id=$1 AND elaboration_date=$2`, [p.productId, p.date]);
    const lotCode = same[0].n ? `${base}-${same[0].n + 1}` : base;

    const pid = await insertProduction(c, {
      kind: 'PREPARACION', code, productId: p.productId, good: obtained, planned, date: p.date, elab: p.date,
      lotCode, shift: p.shift, line: p.line, notes: p.notes, userId: user.id,
    });
    let total = 0;
    for (const l of lines) {
      const { cost } = await consume(c, { itemId: l.componentId, qty: l.actual, mtype: 'CONSUMO', refType: 'production', refId: pid, userId: user.id, notes: `${code} · lote ${lotCode}` });
      total += cost;
      await saveConsumption(c, pid, l, cost);
    }
    await addLot(c, {
      itemId: p.productId, lotCode, source: 'PRODUCCION', productionId: pid, unitCost: total / obtained, qty: obtained,
      mtype: 'PRODUCCION', refType: 'production', refId: pid, userId: user.id, notes: code,
    });
    await c.query('UPDATE productions SET total_cost=$2 WHERE id=$1', [pid, total]);
    return { id: pid, code, lotCode };
  });
}

// ---------------------------------------------------------------- Envasado (envasador)
// Producto preparado (de un lote elegido) + envases => producto terminado. El PT hereda el lote.
async function registerPackaging(user, p) {
  const good = round4(Number(p.qtyGood) || 0);
  const rej = round4(Number(p.qtyRejected) || 0);
  if (good < 0 || rej < 0 || good + rej <= 0) throw new AppError('Indica las unidades envasadas (buenas y/o rechazadas)');

  return tx(async (c) => {
    const product = await getItem(c, p.productId);
    if (product.type !== 'PT') throw new AppError('Selecciona un producto terminado');
    const recipe = await getRecipe(p.productId, c);
    const bulkLine = recipe.find((r) => r.type === 'PP');
    if (!bulkLine) throw new AppError(`${product.name} no tiene definido el producto preparado que contiene`);

    const { rows: lr } = await c.query('SELECT * FROM v_lot_stock WHERE id=$1', [Number(p.bulkLotId) || 0]);
    const lot = lr[0];
    if (!lot || lot.item_id !== bulkLine.component_id) throw new AppError('Selecciona un lote del producto preparado');
    if (!(lot.qty > 0)) throw new AppError(`El lote ${lot.lot_code} no tiene existencia`);

    let elab = null;
    if (lot.production_id) {
      const { rows } = await c.query('SELECT elaboration_date FROM productions WHERE id=$1', [lot.production_id]);
      elab = rows[0].elaboration_date;
    } else {
      const { rows } = await c.query(`SELECT to_char($1::timestamptz, 'YYYY-MM-DD') AS d`, [lot.received_at]);
      elab = rows[0].d;
    }
    if (elab > p.date) throw new AppError('La fecha de envasado no puede ser anterior a la elaboración del lote');

    const lines = withActuals(theoretical(recipe, good + rej), p.consumptions);
    requireNoteIfDeviation(lines.filter((l) => dev(l.actual, l.qty) > TOLERANCE).length, p.notes);

    const code = await nextProductionCode(c, 'ENVASADO', p.date);
    await lockItems(c, [p.productId, ...lines.map((l) => l.componentId)]);

    const pid = await insertProduction(c, {
      kind: 'ENVASADO', code, productId: p.productId, good, rejected: rej, date: p.date, elab, lotCode: lot.lot_code,
      bulkLotId: lot.id, shift: p.shift, line: p.line, notes: p.notes, userId: user.id,
    });
    let total = 0;
    for (const l of lines) {
      const o = { itemId: l.componentId, qty: l.actual, mtype: 'CONSUMO', refType: 'production', refId: pid, userId: user.id, notes: `${code} · lote ${lot.lot_code}` };
      const { cost } = l.componentId === bulkLine.component_id ? await consumeLot(c, { ...o, lotId: lot.id }) : await consume(c, o);
      total += cost;
      await saveConsumption(c, pid, l, cost);
    }
    if (good > 0) {
      await addLot(c, {
        itemId: p.productId, lotCode: lot.lot_code, source: 'PRODUCCION', productionId: pid, unitCost: total / good, qty: good,
        mtype: 'PRODUCCION', refType: 'production', refId: pid, userId: user.id, notes: code,
      });
    }
    await c.query('UPDATE productions SET total_cost=$2 WHERE id=$1', [pid, total]);
    return { id: pid, code, lotCode: lot.lot_code };
  });
}

async function annulProduction(user, id, reason) {
  if (!reason) throw new AppError('Indica el motivo de la anulación');
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM productions WHERE id=$1 FOR UPDATE', [id]);
    if (!rows[0] || rows[0].status !== 'registrada') throw new AppError('Registro no encontrado o ya anulado');
    await reverseRef(c, 'production', id, user.id, `Anulación ${rows[0].code}: ${reason}`);
    await c.query(`UPDATE productions SET status='anulada', annulled_by=$2, annulled_at=now(), annul_reason=$3 WHERE id=$1`,
      [id, user.id, reason]);
  });
}

// ---------------------------------------------------------------- Salidas y ajustes
async function createDispatch(user, d) {
  const qty = round4(Number(d.qty));
  if (!(qty > 0)) throw new AppError('Cantidad inválida');
  return tx(async (c) => {
    await lockItems(c, [d.itemId]);
    const { rows } = await c.query(
      `INSERT INTO dispatches(item_id, qty, destination, doc_number, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [d.itemId, qty, d.destination || null, d.docNumber || null, d.notes || null, user.id]);
    await consume(c, { itemId: d.itemId, qty, mtype: 'SALIDA', refType: 'dispatch', refId: rows[0].id, userId: user.id, notes: d.destination });
    return rows[0].id;
  });
}

async function createAdjustment(user, a) {
  const counted = round4(Number(a.countedQty));
  if (!(counted >= 0)) throw new AppError('Cantidad contada inválida');
  if (!(a.reason || '').trim()) throw new AppError('Indica el motivo del ajuste');
  return tx(async (c) => {
    await lockItems(c, [a.itemId]);
    const sys = round4(await itemStock(c, a.itemId));
    const diff = round4(counted - sys);
    if (diff === 0) throw new AppError(`El conteo coincide con el sistema (${sys}). No hay nada que ajustar.`);
    const { rows } = await c.query(
      `INSERT INTO adjustments(item_id, system_qty, counted_qty, reason, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [a.itemId, sys, counted, a.reason, user.id]);
    const aid = rows[0].id;
    if (diff < 0) {
      await consume(c, { itemId: a.itemId, qty: -diff, mtype: 'AJUSTE', refType: 'adjustment', refId: aid, userId: user.id, notes: a.reason });
    } else {
      const { rows: last } = await c.query('SELECT unit_cost FROM lots WHERE item_id=$1 ORDER BY received_at DESC, id DESC LIMIT 1', [a.itemId]);
      await addLot(c, {
        itemId: a.itemId, lotCode: `AJ-${aid}`, source: 'AJUSTE', unitCost: last[0] ? last[0].unit_cost : 0, qty: diff,
        mtype: 'AJUSTE', refType: 'adjustment', refId: aid, userId: user.id, notes: a.reason,
      });
    }
    return { id: aid, diff };
  });
}

module.exports = {
  AppError, TOLERANCE, round4, getRecipe, capacity, theoretical,
  createPurchase, annulPurchase, registerPreparation, registerPackaging, annulProduction, createDispatch, createAdjustment,
};
