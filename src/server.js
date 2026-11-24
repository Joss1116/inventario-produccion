const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const { pool } = require('./db');
const { migrate } = require('./migrate');
const { AppError } = require('./services/inventory');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': null } }, // permite HTTP (traefik.me)
  hsts: false,
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d' }));

app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'cambia-este-secreto',
  resave: false,
  saveUninitialized: false,
  name: 'invprod.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true', // pon true cuando tengas HTTPS
    maxAge: 1000 * 60 * 60 * 12,
  },
}));

// CSRF + helpers para las vistas
app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  if (req.method === 'POST') {
    const t = req.body?._csrf || req.get('x-csrf-token');
    if (t !== req.session.csrf) return res.status(403).send('Sesión expirada. Recarga la página.');
  }
  const flash = req.session.flash; delete req.session.flash;
  const form = (req.method === 'GET' && req.session.lastForm) || {};
  if (req.method === 'GET') delete req.session.lastForm;
  res.locals.form = form;
  Object.assign(res.locals, {
    user: req.session.user || null,
    csrf: req.session.csrf,
    flash,
    path: req.path,
    n: (v, d = 2) => Number(v || 0).toLocaleString('es-DO', { minimumFractionDigits: 0, maximumFractionDigits: d }),
    money: (v) => 'RD$ ' + Number(v || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    d: (v) => (v ? new Date(v).toLocaleString('es-DO', { timeZone: process.env.TZ || 'America/Santo_Domingo', dateStyle: 'short', timeStyle: 'short' }) : ''),
    TYPES: { MP: 'Materia prima', ENV: 'Envase / empaque', PT: 'Producto terminado' },
    today: () => new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/Santo_Domingo' }),
  });
  req.flash = (type, msg) => { req.session.flash = { type, msg }; };
  next();
});

app.get('/health', (req, res) => res.send('ok'));
app.use(require('./routes/auth'));
app.use(require('./routes/main'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'No encontrado', message: 'La página no existe.' }));

app.use((err, req, res, next) => {
  if (err instanceof AppError || err.code === '23505') {
    const msg = err.code === '23505' ? 'Ya existe un registro con ese código/nombre.' : err.message;
    req.flash('error', msg);
    req.session.lastForm = req.body;
    return res.redirect(req.get('referer') || '/');
  }
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: 'Ocurrió un error inesperado. Revisa los logs.' });
});

const PORT = process.env.PORT || 3000;
migrate()
  .then(() => app.listen(PORT, () => console.log(`Inventario de Producción escuchando en :${PORT}`)))
  .catch((e) => { console.error('Error al migrar', e); process.exit(1); });
