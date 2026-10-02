/**
 * Typed errors so every route maps failures to the right status code instead
 * of a generic 500 (or, worse, a 401 for a bad password policy).
 */
export class ValidationError extends Error {
  constructor(message: string, readonly details?: unknown) { super(message); this.name = 'ValidationError'; }
}
export class ConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'ConflictError'; }
}
export class NotFoundError extends Error {
  constructor(message = 'Not found.') { super(message); this.name = 'NotFoundError'; }
}
