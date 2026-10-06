import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roles, validateComposition } from '../src/domain/rules.ts';
import { DEFAULT_VICTORY_POINTS } from '../src/domain/scoring.ts';
import { presetComposition, parseFavorite, adaptFavorite } from '../src/web/saved-settings.ts';
import type { FavoriteSettings } from '../src/web/saved-settings.ts';

test('全人数のプリセットが有効で未対応役職を追加しない', () => {
  for (let count = 5; count <= 13; count++) for (const kind of ['standard', 'basic', 'special'] as const) {
    const result = presetComposition(count, kind, roles);
    validateComposition(count, result);
    if (kind === 'basic') assert.equal(result.madman, 0);
    if (kind === 'special') assert.ok(result.villager >= 1);
  }
  const supported = roles.filter(role => !['hunter','thief','baker'].includes(role));
  const legacy = presetComposition(10, 'special', supported);
  assert.equal(legacy.hunter, 0); assert.equal(legacy.thief, 0); assert.equal(legacy.baker, 0);
  assert.throws(() => presetComposition(4, 'standard', roles));
});
const favorite = (): FavoriteSettings => ({version:1,count:10,composition:presetComposition(10,'special',roles),minutes:4,points:{...DEFAULT_VICTORY_POINTS,wolf:9},consecutiveGuard:false,wolfboundEnabled:true});
test('お気に入りは全設定を復元し、人数差は村人数で調整する', () => {
  const value = favorite(); const saved = parseFavorite(JSON.stringify(value)); assert.deepEqual(saved, value);
  const adapted = adaptFavorite(saved!,12,roles);
  assert.equal(adapted.composition!.villager,value.composition!.villager+2);
  assert.equal(adapted.points.wolf,9); assert.equal(adapted.minutes,4); assert.equal(adapted.consecutiveGuard,false); assert.equal(adapted.wolfboundEnabled,true);
  assert.equal(value.count,10); assert.equal(value.composition!.villager,1);
  assert.throws(() => adaptFavorite(value,5,roles));
  assert.throws(() => adaptFavorite(value,10,roles.filter(role=>role!=='hunter')));
  const standard = adaptFavorite({...value,composition:null},8,roles); assert.equal(standard.composition,null);
});
test('壊れた保存情報や不正な設定を呼び出さない', () => {
  for (const raw of [null,'bad','{}','null',JSON.stringify({...favorite(),minutes:11}),JSON.stringify({...favorite(),points:{wolf:100}}),JSON.stringify({...favorite(),composition:{villager:10}})]) assert.equal(parseFavorite(raw),null);
});
