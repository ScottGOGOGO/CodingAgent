const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:4000";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseText: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getApiBase() {
  return API_BASE;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    let message = `Request failed with ${response.status}`;
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        message = parsed.error || parsed.message || text;
      } catch {
        message = text;
      }
    }
    throw new ApiError(message, response.status, text);
  }

  return (await response.json()) as T;
}
