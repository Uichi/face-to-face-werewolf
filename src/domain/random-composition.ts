import { DEFAULT_COMPOSITIONS, validateComposition } from './rules.ts';
import type { Composition, Role, RandomIndex } from './rules.ts';
export const RANDOM_ROLES: Role[] = ['seer','medium','knight','madman','lover','baker','thief','hunter','doctor'];
export type CompositionMode = 'standard' | 'custom' | 'random';
export function randomCombinations(count: number, candidates: readonly Role[]): Composition[] {
  if (!DEFAULT_COMPOSITIONS[count] || new Set(candidates).size !== candidates.length || candidates.some(role=>!RANDOM_ROLES.includes(role))) throw new Error('抽選候補または人数が不正です');
  const wolves = DEFAULT_COMPOSITIONS[count]!.wolf;
  const combinations: Composition[] = [];
  // Reverse iteration preserves the existing binary-mask order for saved candidates.
  const ordered=[...candidates].reverse();
  const enumerate=(index:number,comp:Composition):void=>{
    if(index===ordered.length){if(comp.villager>=1){validateComposition(count,comp);combinations.push({...comp});}return;}
    const role=ordered[index]!;
    for(const amount of role==='doctor'?[0,1,2]:role==='lover'?[0,2]:[0,1])enumerate(index+1,{...comp,[role]:amount,villager:comp.villager-amount});
  };
  enumerate(0,{villager:count-wolves,wolf:wolves,seer:0,medium:0,knight:0,madman:0,lover:0,baker:0,thief:0,hunter:0,doctor:0});
  return combinations;
}
export function randomComposition(count:number,candidates:readonly Role[],random:RandomIndex):Composition {
  const choices=randomCombinations(count,candidates);const index=random(choices.length);
  if(!Number.isInteger(index)||index<0||index>=choices.length)throw new Error('乱数が不正です');
  return {...choices[index]!};
}
