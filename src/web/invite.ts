export function invitationUrl(origin: string, pathname: string, code: string, preview: boolean, base?: string): string {
  const target = new URL(pathname, base?.trim() || origin);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('招待URLの設定が不正です。');
  target.search = '';
  target.hash = '';
  target.searchParams.set(preview ? 'preview' : 'room', preview ? '1' : code);
  return target.toString();
}

// getRandomValues also works on local Wi-Fi HTTP pages where randomUUID is unavailable.
export function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
