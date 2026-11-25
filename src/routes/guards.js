const { can } = require('../services/perms');

const deny = (res) => res.status(403).render('error', { title: 'Sin permiso', message: 'Tu perfil no tiene acceso a esta sección.' });

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') return deny(res);
  next();
}
// Exige al menos uno de los permisos indicados
function requirePerm(...perms) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!perms.some((p) => can(req.session.user.role, p))) return deny(res);
    next();
  };
}
module.exports = { requireLogin, requireAdmin, requirePerm, deny };
