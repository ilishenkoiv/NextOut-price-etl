// Diagnostics only: finite vocabulary prevents arbitrary upstream prose/credentials escaping.
export const HTTP400_BODY_CAP = 4096;
const words = new Set(('origin destination departure return date dates at airport airports city cities code codes parameter parameters request bad invalid unsupported unknown missing required same equal identical different must cannot can not be are is the and or to from format market currency limit page value values greater than less before after round trip roundtrip one way direct error validation failed of for should valid yyyy mm dd').split(' '));
export function safeProviderError(value, secret = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const clean = (text, code = false) => {
    if (typeof text !== 'string' || !text || text.length > (code ? 64 : 160)
      || (secret && text.toLowerCase().includes(secret.toLowerCase()))) return undefined;
    if (code && text === '400') return text;
    if (!(code ? /^[A-Z_]+$/ : /^[A-Za-z .'-]+$/).test(text)) return undefined;
    const terms = text.toLowerCase().split(code ? /_+/ : /[ .'-]+/).filter(Boolean);
    if (!terms.length || !terms.every(word => words.has(word))) return undefined;
    return text;
  };
  const providerCode = clean(value.code, true), providerMessage = clean(value.message);
  return providerCode || providerMessage ? { ...(providerCode ? { providerCode } : {}), ...(providerMessage ? { providerMessage } : {}) } : null;
}
export async function readHttp400Error(response, { deadline, clock = Date.now, secret = '' }) {
  let reader, timer;
  const remaining = Math.min(250, deadline - clock());
  if (!(remaining > 0) || response?.status !== 400) return null;
  // A ready reader can starve timers; enforce elapsed time inside the loop as well.
  const diagnosticDeadline = performance.now() + remaining;
  const expired = () => clock() >= deadline || performance.now() >= diagnosticDeadline;
  try {
    if (!response.body?.getReader) return null;
    reader = response.body.getReader();
    const read = async () => {
      const parts = []; let size = 0, emptyChunks = 0;
      for (;;) {
        if (expired()) return null;
        const { done, value } = await reader.read();
        if (expired()) return null;
        if (done) break;
        if (!(value instanceof Uint8Array) || (size += value.byteLength) > HTTP400_BODY_CAP) return null;
        // Empty buffers must neither accumulate nor spin until an event-loop timer runs.
        if (value.byteLength === 0) { if (++emptyChunks >= 32) return null; continue; }
        parts.push(value);
      }
      if (expired()) return null;
      const bytes = new Uint8Array(size); let at = 0;
      for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      const error = body.error;
      const value = error && typeof error === 'object' && !Array.isArray(error)
        ? { code: error.code, message: error.message }
        : { code: body.error_code ?? body.code, message: typeof error === 'string' ? error : body.message };
      return safeProviderError(value, secret);
    };
    return await Promise.race([read(), new Promise(resolve => { timer = setTimeout(() => resolve(null), remaining); })]);
  } catch { return null; }
  finally {
    clearTimeout(timer);
    try { const cancellation = reader?.cancel(); cancellation?.catch(() => {}); } catch {}
    try { reader?.releaseLock(); } catch {}
  }
}
