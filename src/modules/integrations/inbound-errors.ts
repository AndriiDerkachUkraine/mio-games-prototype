import { HttpStatus } from '@nestjs/common';
import type { ZodError } from 'zod';
import { DomainError } from '../../common/domain-error';
import { formatIssues } from '../../common/validation';

export const unauthorizedEvent = (reason: string): DomainError =>
  new DomainError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED_EVENT', reason);

export const invalidEvent = (error: ZodError): DomainError =>
  new DomainError(HttpStatus.UNPROCESSABLE_ENTITY, 'INVALID_EVENT', formatIssues(error));
