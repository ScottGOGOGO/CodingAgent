const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:4000";

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
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        throw new Error(parsed.error || parsed.message || text);
      } catch {
        throw new Error(text);
      }
    }
    throw new Error(`Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}
