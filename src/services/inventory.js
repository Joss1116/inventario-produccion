// Núcleo de la lógica de inventario: lotes, FIFO/FEFO, producción, reversos.
const { query, tx } = require('../db');

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
    `SELECT r.*, i.code, i.name, i.unit, i.type, COALESCE(s.stock,0) AS stock
     FROM recipe_lines r JOIN items i ON i.id=r.component_id
     LEFT JOIN v_item_stock s ON s.id=i.id
     WHERE r.product_id=$1 ORDER BY i.type, i.name`, [productId]);
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

// ---------------------------------------------------------------- Compras
async function createPurchase(user, p) {
  if (!p.lines.length) throw new AppError('Agrega al menos una línea');
  return tx(async (c) => {
    let supplierId = null;
    if (p.supplier) {
      const { rows } = await c.query(
        `INSERT INTO suppliers(name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [p.supplier.trim()]);
      supplierId = rows[0].id;
    }
    const { rows } = await c.query(
      `INSERT INTO purchases(doc_number, supplier_id, purchase_date, notes, is_initial, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [p.docNumber || null, supplierId, p.date, p.notes || null, !!p.initial, user.id]);
    const pid = rows[0].id;
    await lockItems(c, p.lines.map((l) => l.itemId));
    for (const l of p.lines) {
      const it = await getItem(c, l.itemId);
      if (it.type === 'PT' && !p.initial) throw new AppError(`${it.name} es producto terminado; entra por Producción (o marca "Inventario inicial")`);
      const kind = p.initial ? 'INICIAL' : 'COMPRA';
      await addLot(c, {
        itemId: l.itemId, lotCode: l.lotCode || p.docNumber || `${p.initial ? 'INI' : 'C'}-${pid}`, source: kind,
        purchaseId: pid, expiry: l.expiry, unitCost: l.unitCost, qty: l.qty,
        mtype: kind, refType: 'purchase', refId: pid, userId: user.id,
      });
    }
    return pid;
  });
}

async function annulPurchase(user, id, reason) {
  if (!reason) throw new AppError('Indica el motivo de la anulación');
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM purchases WHERE id=$1 FOR UPDATE', [id]);
    if (!rows[0] || rows[0].status !== 'activa') throw new AppError('Compra no encontrada o ya anulada');
    await reverseRef(c, 'purchase', id, user.id, `Anulación: ${reason}`);
    await c.query(`UPDATE purchases SET status='anulada', annulled_by=$2, annulled_at=now(), annul_reason=$3 WHERE id=$1`,
      [id, user.id, reason]);
  });
}

// ---------------------------------------------------------------- Producción
function theoretical(recipe, units) {
  return recipe.map((r) => ({
    componentId: r.component_id,
    qty: round4(r.qty_per_unit * units * (1 + r.waste_pct / 100)),
  }));
}

async function registerProduction(user, p) {
  const good = round4(Number(p.qtyGood) || 0);
  const rej = round4(Number(p.qtyRejected) || 0);
  if (good < 0 || rej < 0 || good + rej <= 0) throw new AppError('Indica la cantidad envasada (buenas y/o rechazadas)');

  return tx(async (c) => {
    const product = await getItem(c, p.productId);
    if (product.type !== 'PT') throw new AppError('Selecciona un producto terminado');
    const recipe = await getRecipe(p.productId, c);
    if (!recipe.length) throw new AppError(`${product.name} no tiene fórmula. El administrador debe definirla primero.`);

    const theo = theoretical(recipe, good + rej);
    const actualMap = new Map((p.consumptions || []).map((x) => [Number(x.componentId), x.actualQty]));
    const lines = theo.map((t) => {
      const raw = actualMap.get(t.componentId);
      const actual = raw === undefined || raw === '' || raw === null ? t.qty : round4(Number(raw));
      if (!(actual >= 0)) throw new AppError('Consumo real inválido');
      return { ...t, actual };
    });

    // Control: desviaciones fuera de tolerancia exigen observación
    const outOfTol = lines.filter((l) => l.qty > 0 && Math.abs(l.actual - l.qty) / l.qty * 100 > TOLERANCE);
    if (outOfTol.length && !(p.notes || '').trim()) {
      throw new AppError(`Hay ${outOfTol.length} consumo(s) con desviación mayor a ${TOLERANCE}% respecto a la fórmula. Escribe una observación que lo explique.`);
    }

    await c.query('SELECT pg_advisory_xact_lock(2, 0)');
    await lockItems(c, [p.productId, ...lines.map((l) => l.componentId)]);

    const elab = p.elaborationDate || p.date;
    if (elab > p.date) throw new AppError('La fecha de elaboración no puede ser posterior a la fecha de envasado');
    const lotCode = elab.replace(/-/g, '');
    const ymd = p.date.replace(/-/g, '');
    const { rows: cnt } = await c.query('SELECT COUNT(*)::int AS n FROM productions WHERE production_date=$1', [p.date]);
    const code = `P-${ymd}-${String(cnt[0].n + 1).padStart(3, '0')}`;

    const { rows } = await c.query(
      `INSERT INTO productions(code, product_id, qty_good, qty_rejected, production_date, elaboration_date, lot_code, shift, line, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [code, p.productId, good, rej, p.date, elab, lotCode, p.shift || null, p.line || null, p.notes || null, user.id]);
    const pid = rows[0].id;

    let totalCost = 0;
    for (const l of lines) {
      const { cost } = await consume(c, {
        itemId: l.componentId, qty: l.actual, mtype: 'CONSUMO',
        refType: 'production', refId: pid, userId: user.id, notes: `${code} · lote ${lotCode}`,
      });
      totalCost += cost;
      await c.query(
        `INSERT INTO production_consumptions(production_id, component_id, theoretical_qty, actual_qty, cost)
         VALUES ($1,$2,$3,$4,$5)`, [pid, l.componentId, l.qty, l.actual, cost]);
    }

    if (good > 0) {
      await addLot(c, {
        itemId: p.productId, lotCode, source: 'PRODUCCION', productionId: pid,
        unitCost: totalCost / good, qty: good,
        mtype: 'PRODUCCION', refType: 'production', refId: pid, userId: user.id, notes: code,
      });
    }
    await c.query('UPDATE productions SET total_cost=$2 WHERE id=$1', [pid, totalCost]);
    return { id: pid, code, lotCode };
  });
}

async function annulProduction(user, id, reason) {
  if (!reason) throw new AppError('Indica el motivo de la anulación');
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM productions WHERE id=$1 FOR UPDATE', [id]);
    if (!rows[0] || rows[0].status !== 'registrada') throw new AppError('Producción no encontrada o ya anulada');
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
  createPurchase, annulPurchase, registerProduction, annulProduction, createDispatch, createAdjustment,
};
