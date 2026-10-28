/** Domain errors carry a stable code that the HTTP layer maps to a status. */
export class DomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new DomainError('E_BAD_REQUEST', message, details);
export const notFound = (message, details) => new DomainError('E_NOT_FOUND', message, details);
export const conflict = (message, details) => new DomainError('E_CONFLICT', message, details);
export const limitReached = (message, details) => new DomainError('E_LIMIT', message, details);
export const invalidState = (message, details) => new DomainError('E_STATE', message, details);
export const acceptanceError = (message, details) => new DomainError('E_ACCEPTANCE', message, details);
