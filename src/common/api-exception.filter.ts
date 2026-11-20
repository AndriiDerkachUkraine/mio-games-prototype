import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DomainError } from './domain-error';

interface ApiError {
  error: string;
  message: string;
}

/** Every error leaves the API as `{ error, message }`; unexpected ones are logged and never leak details. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@InjectPinoLogger(ApiExceptionFilter.name) private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body } = this.toResponse(exception);
    host.switchToHttp().getResponse<Response>().status(status).json(body);
  }

  private toResponse(exception: unknown): { status: number; body: ApiError } {
    if (exception instanceof DomainError) {
      return { status: exception.status, body: { error: exception.code, message: exception.message } };
    }
    if (exception instanceof HttpException) return httpError(exception.getStatus(), exception.message);
    if (isExposedClientError(exception)) return httpError(exception.status, exception.message);
    this.logger.error({ err: exception }, 'unhandled error');
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: 'INTERNAL_ERROR', message: 'internal error' },
    };
  }
}

const httpError = (status: number, message: string) => ({
  status,
  body: { error: HttpStatus[status] ?? 'HTTP_ERROR', message },
});

/** Errors from Express middleware (e.g. body-parser's 413) mark client-safe ones with `expose: true`. */
function isExposedClientError(e: unknown): e is { status: number; message: string } {
  if (typeof e !== 'object' || e === null) return false;
  const { expose, status, message } = e as { expose?: unknown; status?: unknown; message?: unknown };
  return expose === true && typeof status === 'number' && status >= 400 && status < 500 && typeof message === 'string';
}
