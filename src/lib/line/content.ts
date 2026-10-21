const LINE_CONTENT_BASE_URL = "https://api-data.line.me/v2/bot/message";

export interface LineMessageContent {
  bytes: Uint8Array;
  mimeType: string | null;
}

export async function downloadLineMessageContent(
  messageId: string,
  accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN,
  options: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<LineMessageContent> {
  if (!accessToken) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  }

  // The timeout covers the headers AND the body read (fetch aborts both).
  const signals: AbortSignal[] = [];
  if (options.timeoutMs) signals.push(AbortSignal.timeout(options.timeoutMs));
  if (options.signal) signals.push(options.signal);
  const signal = signals.length === 0
    ? undefined
    : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  const response = await fetch(
    `${LINE_CONTENT_BASE_URL}/${encodeURIComponent(messageId)}/content`,
    {
      method: "GET",
      ...(signal ? { signal } : {}),
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`LINE content download failed with HTTP ${response.status}`);
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || null;
  let bytes: Uint8Array;
  if (options.maxBytes !== undefined) {
    if (Number(response.headers.get("content-length")) > options.maxBytes) {
      await response.body?.cancel();
      throw new Error("LINE content exceeds size limit");
    }
    if (!response.body) throw new Error("LINE content download returned an empty body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > options.maxBytes) throw new Error("LINE content exceeds size limit");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  if (bytes.byteLength === 0) {
    throw new Error("LINE content download returned an empty body");
  }

  return { bytes, mimeType };
}
