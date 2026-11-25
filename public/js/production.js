// Formulario de preparación / envasado: calcula consumo teórico y desviaciones en vivo
(function () {
  const cfg = JSON.parse(document.getElementById('cfg').textContent);
  const unitsInputs = Array.from(document.querySelectorAll('[data-units]'));
  const rows = Array.from(document.querySelectorAll('tr[data-qpu]'));
  const warn = document.getElementById('warn');
  const fmt = (v) => (Math.round(v * 10000) / 10000).toLocaleString('es-DO', { maximumFractionDigits: 4 });

  // Envasado: al cambiar el lote, el disponible del producto preparado es el del lote
  const lotSel = document.getElementById('bulkLot');
  const bulkRow = document.querySelector('tr[data-bulk]');
  function syncLot() {
    if (!lotSel || !bulkRow) return;
    const opt = lotSel.selectedOptions[0];
    const q = opt && opt.dataset.qty ? parseFloat(opt.dataset.qty) : 0;
    bulkRow.dataset.stock = q;
    bulkRow.querySelector('.stock').textContent = fmt(q) + ' ' + (bulkRow.dataset.unit || '') + (opt && opt.value ? ' (lote ' + opt.dataset.code + ')' : '');
  }

  // Preparación: el obtenido por defecto es lo planificado
  const planned = document.getElementById('plannedQty');
  const obtained = document.getElementById('obtainedQty');
  const yieldEl = document.getElementById('yield');

  function recalc() {
    const units = unitsInputs.reduce((s, el) => s + (parseFloat(el.value) || 0), 0);
    const issues = [];
    rows.forEach((tr) => {
      const theo = Math.round(parseFloat(tr.dataset.qpu) * units * (1 + parseFloat(tr.dataset.waste) / 100) * 10000) / 10000;
      const stock = parseFloat(tr.dataset.stock);
      const input = tr.querySelector('.actual');
      tr.querySelector('.theo').textContent = fmt(theo);
      if (!input.dataset.touched) input.value = theo || '';
      const actual = parseFloat(input.value);
      const v = tr.querySelector('.var');
      if (theo > 0 && !isNaN(actual)) {
        const pct = (actual - theo) / theo * 100;
        v.textContent = (pct > 0 ? '+' : '') + pct.toFixed(1) + '%';
        v.className = 'r var ' + (Math.abs(pct) > cfg.tolerance ? 'neg' : 'muted');
      } else v.textContent = '—';
      if (!isNaN(actual) && actual > stock + 1e-9) issues.push('Stock insuficiente: ' + tr.dataset.name);
    });
    if (planned && obtained) {
      if (!obtained.dataset.touched) obtained.value = planned.value;
      const p = parseFloat(planned.value); const o = parseFloat(obtained.value);
      if (p > 0 && o > 0) {
        const y = o / p * 100;
        yieldEl.textContent = y.toFixed(1) + '%';
        yieldEl.className = Math.abs(y - 100) > cfg.tolerance ? 'neg' : 'pos';
      } else yieldEl.textContent = '—';
    }
    warn.style.display = issues.length ? 'block' : 'none';
    warn.textContent = issues.join(' · ');
  }

  rows.forEach((tr) => tr.querySelector('.actual').addEventListener('input', (e) => { e.target.dataset.touched = 1; recalc(); }));
  unitsInputs.forEach((el) => el.addEventListener('input', recalc));
  if (obtained) obtained.addEventListener('input', () => { obtained.dataset.touched = 1; recalc(); });
  if (lotSel) lotSel.addEventListener('change', () => { syncLot(); recalc(); });

  const elab = document.getElementById('elab'); const lp = document.getElementById('lotPreview');
  if (elab && lp) { const show = () => { lp.textContent = (elab.value || '').replace(/-/g, ''); }; elab.addEventListener('input', show); show(); }

  syncLot();
  recalc();
})();
