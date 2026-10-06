import { createClient } from '@supabase/supabase-js';
import type { Room } from './types.ts';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
export const configured = Boolean(url && key && !url.includes('your-project') && !key.includes('replace_me'));
export const client = configured ? createClient(url!, key!) : null;
export const captchaSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() || '';
export const SITE_ACCESS_REQUIRED_EVENT = 'werewolf:site-access-required';

type AccessStatus = { ok: boolean; enabled: boolean; unlocked: boolean; expiresAt?: string; message?: string };

function missingAccessFunction(code?: string) { return code === 'PGRST202' || code === '42883'; }
export function siteAccessError(error: { message?: string } | null) {
  if (!error?.message?.includes('SITE_ACCESS_REQUIRED')) return null;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SITE_ACCESS_REQUIRED_EVENT));
  return new Error('合言葉の確認期限が切れました。もう一度入力してください。');
}

export async function siteAccessStatus(): Promise<AccessStatus> {
  if (!client) return { ok: true, enabled: false, unlocked: true };
  const { data, error } = await client.rpc('access_command', { action: 'status', payload: {} });
  if (missingAccessFunction(error?.code)) return { ok: true, enabled: false, unlocked: true };
  if (error) throw new Error('合言葉の確認状態を取得できませんでした。通信を確認してください。');
  return data as AccessStatus;
}

export async function unlockSite(password: string, captchaToken?: string): Promise<AccessStatus> {
  if (!client) return { ok: true, enabled: false, unlocked: true };
  await ensureSession(captchaToken);
  const { data, error } = await client.rpc('access_command', { action: 'unlock', payload: { password } });
  if (missingAccessFunction(error?.code)) return { ok: true, enabled: false, unlocked: true };
  if (error) throw new Error('合言葉を確認できませんでした。通信を確認して、もう一度お試しください。');
  return data as AccessStatus;
}

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
export class RoomAccessLostError extends Error {}
function normalizeRoom(room: Room): Room {
  const bakerRole = room.victoryPoints?.baker !== undefined;
  const thiefRole = room.victoryPoints?.thief !== undefined;
  return { ...room, bakerRole, thiefRole, hunterRole: room.victoryPoints?.hunter !== undefined, composition: room.composition ? { ...room.composition, baker: room.composition.baker ?? 0, thief: room.composition.thief ?? 0, hunter: room.composition.hunter ?? 0 } : room.composition };
}
export async function membership(action: 'remove' | 'leave', payload: Record<string, unknown>): Promise<{ room?: Room; left?: boolean }> {
  if (!client) throw new Error('接続先が設定されていません。');
  const { data, error } = await client.rpc('membership_command', { action, payload });
  const access = siteAccessError(error); if (access) throw access;
  if (error?.code === 'PGRST202') throw new Error('参加者の整理機能は設定の追加待ちです。追加後にページを更新してください。');
  if (error) throw new Error(error.code === 'P0001' ? error.message : '通信を確認して、もう一度お試しください。');
  if (!data?.ok) throw new Error(data?.message || '操作を完了できませんでした。');
  if (data.room) data.room = normalizeRoom(data.room as Room);
  return data;
}
export async function lobby(action: string, payload: Record<string, unknown>): Promise<Room> {
  if (!client) throw new Error('接続先が設定されていません。');
  let { data, error } = await client.rpc('lobby_command_hunter', { action, payload });
  if (missingAccessFunction(error?.code)) ({ data, error } = await client.rpc('lobby_command_wolfbound', { action, payload }));
  if (missingAccessFunction(error?.code)) ({ data, error } = await client.rpc('lobby_command_guard', { action, payload }));
  if (missingAccessFunction(error?.code)) ({ data, error } = await client.rpc('lobby_command_thief', { action, payload }));
  if (missingAccessFunction(error?.code)) ({ data, error } = await client.rpc('lobby_command_baker', { action, payload }));
  if (missingAccessFunction(error?.code)) ({ data, error } = await client.rpc('lobby_command', { action, payload }));
  const access = siteAccessError(error); if (access) throw access;
  if (error) throw new Error('部屋に接続できませんでした。通信を確認して、もう一度お試しください。');
  if (data?.code === 'ROOM_ACCESS_LOST') throw new RoomAccessLostError(data.message);
  if (!data?.ok) throw new Error(data?.message || '操作を完了できませんでした。');
  return normalizeRoom(data.room as Room);
}

let subscriptionId = 0;
export function watchRoom(roomId: string, refresh: () => void) {
  if (!client) return () => {};
  const channel = client.channel(`room:${roomId}:${++subscriptionId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'room_updates', filter: `room_id=eq.${roomId}` }, refresh)
    .subscribe(status => { if (status === 'SUBSCRIBED') refresh(); });
  return () => { void client!.removeChannel(channel); };
}

export async function resetPoints(payload: Record<string, unknown>): Promise<Room> {
  if (!client) throw new Error('接続先が設定されていません。');
  const { data, error } = await client.rpc('score_command', { action: 'reset', payload });
  const access = siteAccessError(error); if (access) throw access;
  if (error) throw new Error(error.code === 'P0001' ? error.message : '通信を確認して、もう一度お試しください。');
  if (!data?.ok) throw new Error('ポイントをリセットできませんでした。');
  return normalizeRoom(data.room as Room);
}
