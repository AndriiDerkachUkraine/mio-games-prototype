import { HttpStatus } from '@nestjs/common';

/** Expected failure with a stable error code; mapped to HTTP only by DomainErrorFilter. */
export class DomainError extends Error {
  constructor(
    readonly status: HttpStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
