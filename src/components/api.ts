"use client";

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const apiPost = <T,>(url: string, body?: unknown) =>
  api<T>(url, { method: "POST", body: JSON.stringify(body ?? {}) });

export const apiPatch = <T,>(url: string, body: unknown) =>
  api<T>(url, { method: "PATCH", body: JSON.stringify(body) });

export const apiDelete = <T,>(url: string) => api<T>(url, { method: "DELETE" });
