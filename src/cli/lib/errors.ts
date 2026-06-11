export class VernierError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string
  ) {
    super(message);
  }
}
