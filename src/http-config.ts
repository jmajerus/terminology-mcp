const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

export function allowedOrigins(values: string[] = []): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash)
      throw new Error('TERMINOLOGY_ORIGINS must contain HTTP(S) origins without paths or credentials.');
    if (result.has(url.host) && result.get(url.host) !== url.origin)
      throw new Error('Configure only one scheme per public host.');
    result.set(url.host, url.origin);
  }
  return result;
}

export function requestOrigin(host: string | undefined, origins: Map<string, string>): string | null {
  if (!host || /[\s/@?#\\]/.test(host)) return null;
  try {
    const url = new URL(`http://${host}`);
    if (url.host.toLowerCase() !== host.toLowerCase()) return null;
    return origins.get(url.host) ?? (loopback.has(url.hostname) ? url.origin : null);
  } catch { return null; }
}
