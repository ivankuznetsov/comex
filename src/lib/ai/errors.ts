export type AIErrorCode = 'missing_key' | 'provider_error' | 'unknown_outcome' | 'invalid_response' | 'refusal' | 'invalid_input';

export class AIError extends Error {
  constructor(public code: AIErrorCode, message: string) { super(message); this.name = 'AIError'; }
}
