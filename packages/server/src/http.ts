import type { ZodType, ZodTypeDef } from 'zod';
import { z } from 'zod';

/** Error with an HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that') =>
  new ApiError(403, 'forbidden', message);
/** Also used when a resource exists but the caller may not know that. */
export const notFound = (what = 'Resource') => new ApiError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, details?: unknown) =>
  new ApiError(409, 'conflict', message, details);

/** Validates input with a Zod schema, throwing a 400 listing every problem. */
export function parse<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  input: unknown,
  what = 'request',
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest(
      `Invalid ${what}`,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export const UuidParam = z.object({ id: z.string().uuid() });

/** The single expected row of a query result; 404 when there is none. */
export function one<T>(rows: readonly T[], what = 'Resource'): T {
  const row = rows[0];
  if (row === undefined) throw notFound(what);
  return row;
}
