export class IntegrationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
