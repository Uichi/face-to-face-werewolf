// Only opaque game/viewer identifiers are retained, never roles or actions.
export const ROLE_REVEAL_KEY = 'werewolf.role-reveals.v1';
const LIMIT = 100;
const viewed = new Set<string>();
type RevealStorage = Pick<Storage, 'getItem' | 'setItem'>;
export function claimRoleReveal(gameId: string, viewerId: string, storage?: RevealStorage): boolean {
  const key = JSON.stringify([gameId, viewerId]);
  if (viewed.has(key)) return false;
  let saved: string[] = [];
  try {
    const raw: unknown = JSON.parse(storage?.getItem(ROLE_REVEAL_KEY) ?? '[]');
    if (Array.isArray(raw)) saved = raw.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 256).slice(-LIMIT);
  } catch { /* Unavailable storage must never block role confirmation. */ }
  viewed.add(key);
  if (viewed.size > LIMIT) viewed.delete(viewed.values().next().value!);
  if (saved.includes(key)) return false;
  try { storage?.setItem(ROLE_REVEAL_KEY, JSON.stringify([...saved, key].slice(-LIMIT))); } catch { /* Memory still prevents repeats during this visit. */ }
  return true;
}
