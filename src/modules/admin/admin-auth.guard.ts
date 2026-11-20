import { CanActivate, createParamDecorator, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { sha256Hex } from '../../common/crypto';
import { DomainError } from '../../common/domain-error';
import { TenantsRepository } from '../tenancy/tenants.repository';

type AdminRequest = Request & { adminTenantId?: string };

/**
 * Tenant admin API: the X-Admin-Key decides the tenant, so an operator can only ever see and change its own
 * configuration. Keys are stored as SHA-256 hashes; a database leak does not reveal them.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly tenants: TenantsRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const key = req.header('x-admin-key');
    const tenant = key ? await this.tenants.findActiveByAdminKeyHash(sha256Hex(key)) : undefined;
    if (!tenant) throw new DomainError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED_ADMIN', 'invalid admin key');
    req.adminTenantId = tenant.id;
    return true;
  }
}

/** The tenant the admin key belongs to; only valid behind AdminAuthGuard. */
export const AdminTenant = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const tenantId = context.switchToHttp().getRequest<AdminRequest>().adminTenantId;
  if (!tenantId) throw new Error('AdminTenant used on a route without AdminAuthGuard');
  return tenantId;
});
