(function () {
  const cfg = JSON.parse(document.getElementById('cfg').textContent);
  const good = document.getElementById('qtyGood');
  const rej = document.getElementById('qtyRejected');
  const rows = Array.from(document.querySelectorAll('tr[data-qpu]'));
  const warn = document.getElementById('warn');
  const fmt = (v) => (Math.round(v * 10000) / 10000).toLocaleString('es-DO', { maximumFractionDigits: 4 });

  function recalc() {
    const units = (parseFloat(good.value) || 0) + (parseFloat(rej.value) || 0);
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
      const name = tr.cells[0].innerText.trim();
      if (!isNaN(actual) && actual > stock + 1e-9) issues.push('Stock insuficiente: ' + name);
    });
    warn.style.display = issues.length ? 'block' : 'none';
    warn.textContent = issues.join(' · ');
  }
  rows.forEach((tr) => tr.querySelector('.actual').addEventListener('input', (e) => { e.target.dataset.touched = 1; recalc(); }));
  [good, rej].forEach((el) => el.addEventListener('input', recalc));
  const elab = document.getElementById('elab'); const lp = document.getElementById('lotPreview');
  const showLot = () => { lp.textContent = (elab.value || '').replace(/-/g, ''); };
  elab.addEventListener('input', showLot); showLot();
  recalc();
})();
