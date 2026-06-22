// ─────────────────────────────────────────────────────────────────────────
// admin.js — API pengelolaan user (dibatasi ADMIN_EMAILS)
// ─────────────────────────────────────────────────────────────────────────
import { json, badRequest, forbidden, unauthorized } from './util.js';
import { getSession } from './session.js';
import {
  listUsersWithSub, adminExtendDays, adminSetStatus, adminDeleteUser, adminEditUser,
} from './db.js';

export function isAdmin(env, email) {
  if (!email) return false;
  const list = (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

export async function requireAdmin(request, env) {
  const session = await getSession(request, env);
  if (!session) return { error: unauthorized('Belum login') };
  if (!isAdmin(env, session.email)) return { error: forbidden('Bukan admin') };
  return { session };
}

export async function handleAdminApi(request, env, url) {
  const { error, session } = await requireAdmin(request, env);
  if (error) return error;

  const path = url.pathname;

  if (path === '/api/admin/users' && request.method === 'GET') {
    const users = await listUsersWithSub(env);
    return json({ ok: true, users, admin: session.email });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return badRequest('Body tidak valid'); }
    const email = (body.email || '').trim().toLowerCase();
    if (!email) return badRequest('Email wajib diisi');

    try {
      if (path === '/api/admin/users/extend') {
        const days = parseInt(body.days || '0', 10);
        if (!days || days < 1) return badRequest('days harus > 0');
        const sub = await adminExtendDays(env, email, days);
        return json({ ok: true, sub });
      }
      if (path === '/api/admin/users/suspend') {
        const status = body.status === 'active' ? 'active' : 'suspended';
        await adminSetStatus(env, email, status);
        return json({ ok: true, status });
      }
      if (path === '/api/admin/users/edit') {
        await adminEditUser(env, email, (body.name || '').trim());
        return json({ ok: true });
      }
      if (path === '/api/admin/users/delete') {
        await adminDeleteUser(env, email);
        return json({ ok: true });
      }
    } catch (e) {
      return json({ error: e.message || 'Gagal' }, 400);
    }
  }

  return json({ error: 'Not found' }, 404);
}
