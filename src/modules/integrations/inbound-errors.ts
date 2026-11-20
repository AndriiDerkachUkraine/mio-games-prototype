import { HttpStatus } from '@nestjs/common';
import type { ZodError } from 'zod';
import { DomainError } from '../../common/domain-error';

export const unauthorizedEvent = (reason: string): DomainError =>
  new DomainError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED_EVENT', reason);

export const invalidEvent = (error: ZodError): DomainError =>
  new DomainError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'INVALID_EVENT',
    error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
  );
