import { requireActor } from '@/server/auth';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => {
  const a = await requireActor(req, { allowPasswordChange: true });
  return { id: a.id, full_name: a.full_name, email: a.email, role: a.role_name, role_code: a.role_code,
    department: a.department_name, department_side: a.department_side, app_only: a.app_only, must_change_password: a.must_change_password,
    permissions: [...a.perms].sort(), financial_access: a.fin };
});
