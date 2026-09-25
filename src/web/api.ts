import { createClient } from '@supabase/supabase-js';
import type { Room } from './types.ts';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
export const configured = Boolean(url && key && !url.includes('your-project') && !key.includes('replace_me'));
export const client = configured ? createClient(url!, key!) : null;
export const captchaSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() || '';

export async function hasSession() {
  if (!client) return false;
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return Boolean(data.session);
}
let signingIn: Promise<void> | null = null;
export async function ensureSession(captchaToken?: string) {
  if (!client) throw new Error('接続の準備中です。画面プレビューをお試しください。');
  if (await hasSession()) return;
  if (!signingIn) signingIn = (async () => {
    const { error } = await client!.auth.signInAnonymously({ options: { captchaToken } });
    if (error) throw new Error('参加の準備ができませんでした。通信を確認して、もう一度お試しください。');
  })().finally(() => { signingIn = null; });
  return signingIn;
}
export async function lobby(action: string, payload: Record<string, unknown>): Promise<Room> {
  if (!client) throw new Error('接続先が設定されていません。');
  const { data, error } = await client.rpc('lobby_command', { action, payload });
  if (error) throw new Error('部屋に接続できませんでした。通信を確認して、もう一度お試しください。');
  if (!data?.ok) throw new Error(data?.message || '操作を完了できませんでした。');
  return data.room as Room;
}

export function watchRoom(roomId: string, refresh: () => void) {
  if (!client) return () => {};
  const channel = client.channel(`lobby:${roomId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'room_updates', filter: `room_id=eq.${roomId}` }, refresh)
    .subscribe(status => { if (status === 'SUBSCRIBED') refresh(); });
  return () => { void client!.removeChannel(channel); };
}
