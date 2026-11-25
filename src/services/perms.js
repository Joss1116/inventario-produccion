// Matriz de permisos por perfil. El administrador tiene todo.
const ROLES = {
  admin: 'Administrador',
  recepcionista: 'Recepcionista',
  quimico: 'Químico',
  envasador: 'Envasador',
};

const MATRIX = {
  recepcionista: ['recepcion', 'items.MP', 'items.ENV'],
  quimico: ['preparacion', 'items.PP', 'formulas', 'marcas'],
  envasador: ['envasado'],
};

function can(role, perm) {
  if (role === 'admin') return true;
  return (MATRIX[role] || []).includes(perm);
}

// Qué tipos de artículo puede crear/editar cada perfil
function editableTypes(role) {
  return ['MP', 'ENV', 'PP', 'PT'].filter((t) => can(role, `items.${t}`) || (t === 'PT' && role === 'admin'));
}

module.exports = { ROLES, can, editableTypes };
