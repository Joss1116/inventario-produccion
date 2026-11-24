const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query } = require('../db');

const attempts = new Map(); // freno simple a fuerza bruta por IP

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { title: 'Ingresar', error: null });
});

router.post('/login', async (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).render('login', { title: 'Ingresar', error: 'Demasiados intentos. Espera 15 minutos.' });

  const { username, password } = req.body;
  const { rows } = await query('SELECT * FROM users WHERE lower(username)=lower($1) AND active', [username || '']);
  const u = rows[0];
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    a.n += 1; attempts.set(ip, a);
    return res.status(401).render('login', { title: 'Ingresar', error: 'Usuario o contraseña incorrectos' });
  }
  attempts.delete(ip);
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.user = { id: u.id, username: u.username, full_name: u.full_name, role: u.role };
    res.redirect('/');
  });
});

router.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

module.exports = router;
