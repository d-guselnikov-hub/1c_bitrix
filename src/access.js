// Список допущенных сотрудников и их роли. Хранится в data/access.json, меняется из самого приложения.
// Роли: admin (всё + управление доступом), all (видит всё, без управления), director (свои филиалы), manager (свои клиенты)
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.root, 'data', 'access.json');
export const ROLES = ['admin', 'all', 'director', 'manager'];

const DEFAULT = {
  admins: ['30833'],
  users: [
    { id: '30833', name: 'Денис Гусельников', role: 'admin', branches: [] },
    { id: '10059', name: 'Илхам Хайруллаев', role: 'all', branches: [] },
    { id: '11', name: 'Андрей Чуясов', role: 'all', branches: [] },
    { id: '14869', name: 'Марина Курлейцева', role: 'all', branches: [] },
  ],
};

export const ROOT_ADMIN = '30833'; // основной админ: нельзя разжаловать или убрать
function normalize(j) {
  const old = (j.admins || []).map(String);
  const users = (j.users || []).map(u => {
    const id = String(u.id);
    let role = ROLES.includes(u.role) ? u.role : 'all'; // старые записи без роли видели всё
    if (old.includes(id) || id === ROOT_ADMIN) role = 'admin';
    return { id, name: String(u.name || ''), role, branches: role === 'director' && Array.isArray(u.branches) ? u.branches.map(String) : [] };
  });
  // Админы = все с ролью admin (так админов может назначать любой админ из интерфейса)
  const admins = [...new Set([ROOT_ADMIN, ...users.filter(u => u.role === 'admin').map(u => u.id)])];
  return { admins, users };
}

export function readAccess() {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    writeAccess(DEFAULT);
    return structuredClone(DEFAULT);
  }
}

export function writeAccess(acc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalize(acc), null, 2));
  fs.renameSync(tmp, file);
}

export const isAdmin = id => readAccess().admins.includes(String(id));
// Админ приложения всегда имеет доступ, даже если его случайно убрали из списка
export const isAllowed = id => isAdmin(id) || readAccess().users.some(u => u.id === String(id));
// Роль и филиалы пользователя; null, если доступа нет
export function userScope(id) {
  id = String(id);
  const acc = readAccess();
  if (acc.admins.includes(id)) return { id, role: 'admin', branches: [], name: acc.users.find(u => u.id === id)?.name || '' };
  const u = acc.users.find(x => x.id === id);
  return u ? { id, role: u.role, branches: u.branches, name: u.name } : null;
}
