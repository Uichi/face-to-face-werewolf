import { RANDOM_ROLES } from '../domain/random-composition.ts';
import type { CompositionMode } from '../domain/random-composition.ts';
import { DEFAULT_COMPOSITIONS, roles, validateComposition } from '../domain/rules.ts';
import type { Composition, Role } from '../domain/rules.ts';
import { DEFAULT_VICTORY_POINTS, validateVictoryPoints } from '../domain/scoring.ts';
import type { VictoryPoints } from '../domain/scoring.ts';

export const SETTINGS_KEY = 'werewolf.favorite-settings.v1';
export type FavoriteSettings = { version: 1; mode?: CompositionMode; randomCandidates?: Role[]; count: number; composition: Composition | null; minutes: number; points: VictoryPoints; consecutiveGuard: boolean; wolfboundEnabled: boolean };
export type Preset = 'standard' | 'basic' | 'special';
export function presetComposition(count: number, preset: Preset, supported: Role[]): Composition {
  if (!DEFAULT_COMPOSITIONS[count]) throw new Error('5〜13人でプリセットを選べます');
  const composition = { ...DEFAULT_COMPOSITIONS[count] };
  if (preset === 'basic') { composition.villager += composition.madman; composition.madman = 0; }
  if (preset === 'special') {
    for (const role of ['baker', 'hunter', 'thief'] as const) {
      if (supported.includes(role) && composition.villager > 1) { composition[role] = 1; composition.villager--; }
    }
  }
  validateComposition(count, composition);
  return composition;
}
export function parseFavorite(raw: string | null): FavoriteSettings | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as FavoriteSettings;
    if (value.version !== 1 || !Number.isInteger(value.count) || value.count < 5 || value.count > 13 || !Number.isInteger(value.minutes) || value.minutes < 1 || value.minutes > 10 || typeof value.consecutiveGuard !== 'boolean' || typeof value.wolfboundEnabled !== 'boolean') return null;
    if(value.mode && !['standard','custom','random'].includes(value.mode))return null;
    if(value.mode==='random' && (!Array.isArray(value.randomCandidates)||new Set(value.randomCandidates).size!==value.randomCandidates.length||value.randomCandidates.some(role=>!RANDOM_ROLES.includes(role))||value.composition!==null))return null;
    validateVictoryPoints(value.points);
    if (value.composition !== null) validateComposition(value.count, value.composition);
    if (value.wolfboundEnabled && (value.composition ?? DEFAULT_COMPOSITIONS[value.count]!).villager < 1) return null;
    return value;
  } catch { return null; }
}
export function adaptFavorite(value: FavoriteSettings, count: number, supported: Role[]): FavoriteSettings {
  if (!DEFAULT_COMPOSITIONS[count]) throw new Error('5〜13人そろってから呼び出してください');
  if(value.mode==='random' && value.randomCandidates?.some(role=>!supported.includes(role)))throw new Error('保存した抽選候補に、この部屋で使えない役職があります');
  const composition = value.composition ? { ...value.composition } : null;
  if (composition) {
    for (const role of roles) {
      if (!supported.includes(role) && (composition[role] ?? 0) > 0) throw new Error('保存した設定には、この部屋で使えない役職があります');
    }
    composition.villager += count - value.count;
    if (composition.villager < 0) throw new Error('人数が少ないため呼び出せません。役職を減らした設定を保存してください');
    validateComposition(count, composition);
  }
  if (value.wolfboundEnabled && (composition ?? DEFAULT_COMPOSITIONS[count]!).villager < 1) throw new Error('狼憑き用の村人が足りません');
  return { ...value, count, composition, points: { ...DEFAULT_VICTORY_POINTS, ...value.points } };
}
