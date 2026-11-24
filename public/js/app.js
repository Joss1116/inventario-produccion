document.querySelectorAll('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));
document.querySelectorAll('[data-print]').forEach((el) => el.addEventListener('click', () => window.print()));
document.querySelectorAll('[data-addrow]').forEach((btn) => btn.addEventListener('click', () => {
  const body = document.getElementById(btn.dataset.addrow);
  const row = body.rows[body.rows.length - 1].cloneNode(true);
  row.querySelectorAll('input').forEach((i) => { i.value = ''; });
  row.querySelectorAll('select').forEach((s) => { s.selectedIndex = 0; });
  body.appendChild(row);
}));
// Evita doble envío de formularios (doble clic en "Registrar")
document.querySelectorAll('form[method="post"]').forEach((f) => f.addEventListener('submit', () => {
  f.querySelectorAll('button:not([type="button"])').forEach((b) => { b.disabled = true; });
}));
