import { client, siteAccessError } from './api.ts';
import type { Room } from './types.ts';
import type { viewFor } from '../domain/game.ts';
export type GameView = ReturnType<typeof viewFor>;
export type GameResponse = { ok: true; room: Room; game: GameView | null; serverNow: number };
export class GameError extends Error {
  retryable: boolean;
  constructor(message: string, retryable = false) { super(message); this.retryable = retryable; }
}
export async function gameCommand(action: string, payload: Record<string, unknown>): Promise<GameResponse> {
  if (!client) throw new GameError('接続先が設定されていません。');
  let { data, error } = await client.rpc('game_command_random', { action, payload });
  if (error?.code === 'PGRST202' || error?.code === '42883') ({ data, error } = await client.rpc('game_command_hunter', { action, payload }));
  if (error?.code === 'PGRST202' || error?.code === '42883') ({ data, error } = await client.rpc('game_command_wolfbound', { action, payload }));
  if (error?.code === 'PGRST202' || error?.code === '42883') ({ data, error } = await client.rpc('game_command_guard', { action, payload }));
  if (error?.code === 'PGRST202' || error?.code === '42883') ({ data, error } = await client.rpc('game_command_bread', { action, payload }));
  if (error?.code === 'PGRST202' || error?.code === '42883') ({ data, error } = await client.rpc('game_command_host_results', { action, payload }));
  if (error?.code === 'PGRST202' || error?.code === '42883') ({ data, error } = await client.rpc('game_command_thief', { action, payload }));
  if (error?.code === 'PGRST202' || error?.code === '42883') ({ data, error } = await client.rpc('game_command_public_log', { action, payload }));
  if (error?.code === 'PGRST202' || error?.code === '42883') ({ data, error } = await client.rpc('game_command_first_day', { action, payload }));
  if (error?.code === 'PGRST202' || error?.code === '42883') ({ data, error } = await client.rpc('game_command_baker', { action, payload }));
  if (error?.code === 'PGRST202' || error?.code === '42883') ({ data, error } = await client.rpc('game_command', { action, payload }));
  if (error) {
    const access = siteAccessError(error); if (access) throw new GameError(access.message);
    if (error.code === 'PGRST202') throw new GameError('ゲーム機能の接続準備中です。設定の追加後にページを更新してください。');
    if (error.code === 'P0001') throw new GameError(error.message);
    throw new GameError('通信を確認して、もう一度お試しください。', true);
  }
  if (!data?.ok) throw new GameError(data?.message || '操作を完了できませんでした。');
  return data as GameResponse;
}
