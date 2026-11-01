export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers }, cache: 'no-store' });
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error(`The server returned an unexpected response (${response.status}).`); }
  if (!response.ok) {
    const error = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `Request failed (${response.status}).`;
    throw new Error(error);
  }
  return data as T;
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
