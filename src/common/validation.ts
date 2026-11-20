import { HttpStatus } from '@nestjs/common';
import type { ZodError, ZodType } from 'zod';
import { DomainError } from './domain-error';

export const formatIssues = (error: ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');

/** Parses a request body or throws 422 INVALID_REQUEST listing every problem. */
export function validate<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError(HttpStatus.UNPROCESSABLE_ENTITY, 'INVALID_REQUEST', formatIssues(parsed.error));
  }
  return parsed.data;
}
