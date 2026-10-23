/** POST that streams a plain-text body (AI SDK toTextStreamResponse). Calls onText with the text so far. */
import { ApiError } from "@/lib/api/client";

export async function postTextStream(
  path: string,
  body: unknown,
  onText: (textSoFar: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; headers: Headers }> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }).catch((e) => {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(0, "Bağlantı kurulamadı.", "NETWORK");
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const { error, code, ...details } = data ?? {};
    throw new ApiError(res.status, typeof error === "string" ? error : `İstek başarısız (${res.status}).`, typeof code === "string" ? code : undefined, details);
  }
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      onText(text);
    }
    text += decoder.decode();
  }
  onText(text);
  return { text, headers: res.headers };
}
