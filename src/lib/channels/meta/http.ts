import "server-only";

export class MetaError extends Error {
  constructor(
    public status: number,
    public code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** Запрос к Graph API Instagram/Threads: ошибки Meta превращаются в MetaError с кодом. */
export async function metaFetch<T>(url: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...rest.headers },
    signal: rest.signal ?? AbortSignal.timeout(20000),
  });
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: { message?: string; code?: number; error_user_msg?: string } })
    | { error_message?: string; error_type?: string }
    | null;
  if (!res.ok || !data || ("error" in data && data.error) || ("error_message" in data && data.error_message)) {
    const err = data && "error" in data && data.error ? data.error : null;
    const msg =
      err?.error_user_msg ?? err?.message ?? (data && "error_message" in data ? data.error_message : null) ?? `HTTP ${res.status}`;
    throw new MetaError(res.status, err?.code, String(msg));
  }
  return data as T;
}

/** Делит текст на части не длиннее maxBytes байт UTF-8 (по абзацам, затем по словам). */
export function splitByBytes(text: string, maxBytes: number): string[] {
  const enc = new TextEncoder();
  const size = (s: string) => enc.encode(s).length;
  if (size(text) <= maxBytes) return [text];
  const parts: string[] = [];
  let cur = "";
  for (const word of text.split(/(\s+)/)) {
    if (size(cur + word) > maxBytes && cur.trim()) {
      parts.push(cur.trim());
      cur = "";
    }
    cur += word;
    while (size(cur) > maxBytes) {
      // одно «слово» длиннее лимита — режем по символам
      let i = cur.length;
      while (size(cur.slice(0, i)) > maxBytes) i--;
      parts.push(cur.slice(0, i));
      cur = cur.slice(i);
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
