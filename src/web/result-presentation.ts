import type { GameView } from './game-api.ts';
import type { PublicLogEvent } from '../domain/game.ts';
export type ResultFrame = { id: string; kind: 'dawn' | 'death' | 'notice' | 'victory'; title: string; detail: string; duration: number; label?: string; day?: number; team?: 'village' | 'wolves' };
type PublicGame = GameView['public'];
// Only public snapshots enter presentation; roles and private actions are never read.
export function resultFrames(previous: PublicGame, current: PublicGame, name: (id: string) => string): ResultFrame[] {
  if (previous.id !== current.id || !['execution','morning','hunter','finished'].includes(current.phase)) return [];
  const seen = new Set((previous.publicLog ?? []).map(e => e.id));
  const events = (current.publicLog ?? []).filter(e => !seen.has(e.id));
  const frames: ResultFrame[] = [];
  const night = events.some(e => ['attack','injection','noVictim'].includes(e.kind));
  if (night || current.phase === 'morning' && previous.phase === 'night') frames.push({id:'dawn',kind:'dawn',title:'朝になりました',detail:'昨夜の出来事を確認します',duration:2000,label:'夜明け'});
  const deaths = new Set<string>();
  const follow = (event: PublicLogEvent) => {
    for (const id of event.followedIds ?? []) if (!deaths.has(id)) {
      deaths.add(id); frames.push({id:`${event.id}:follow:${id}`,kind:'death',title:`${name(id)}さんが後追いしました`,detail:`${event.playerId ? name(event.playerId) : '相方'}さんの恋人だったため、脱落しました。`,duration:4000,label:'恋人の後追い',day:event.day});
    }
  };
  // Group simultaneous direct night deaths before their lover follow-ups.
  let nightFollowed = false;
  for (const event of events) {
    if (!['attack','injection','noVictim'].includes(event.kind) && !nightFollowed) {
      const earlierNight = events.slice(0, events.indexOf(event)).filter(e => ['attack','injection'].includes(e.kind));
      if (earlierNight.length) { earlierNight.forEach(follow); nightFollowed = true; }
    }
    const id = event.playerId;
    if (id && ['execution','attack','injection','shot'].includes(event.kind) && !deaths.has(id)) {
      deaths.add(id);
      const votes = event.kind === 'execution' && current.voteResult?.executedId === id ? current.voteResult.counts[id] : undefined;
      const reason = event.kind === 'execution' ? `${votes === undefined ? '' : `${votes}票で`}処刑されました` : event.kind === 'attack' ? '人狼の襲撃で犠牲になりました' : event.kind === 'injection' ? '2回目の注射を受けたため死亡しました' : '狩人の発砲で脱落しました';
      frames.push({id:event.id,kind:'death',title:`${name(id)}さん`,detail:reason,duration:4000,label:({execution:'処刑',attack:'人狼の襲撃',injection:'注射による死亡',shot:'狩人の発砲'} as Record<string,string>)[event.kind],day:event.day});
    }
    if (event.kind === 'noExecution' || event.kind === 'noVictim') frames.push({id:event.id,kind:'notice',title:event.kind === 'noExecution' ? '誰も処刑されませんでした' : '襲撃による犠牲者はいませんでした',detail:event.kind === 'noVictim' ? '犠牲者が出なかった理由は公開されません。' : '投票の結果、処刑はありません。',duration:3500,label:event.kind === 'noExecution' ? '投票結果' : '襲撃結果',day:event.day});
    if (event.kind === 'execution' || event.kind === 'shot') follow(event);
    if (event.kind === 'hunterReady') frames.push({id:event.id,kind:'notice',title:`${id ? name(id) : '狩人'}さんは狩人でした`,detail:'最後の発砲を行います。勝敗はまだ確定していません。',duration:4000,label:'狩人の能力',day:event.day});
    if (event.kind === 'shotCancelled') frames.push({id:event.id,kind:'notice',title:'狩人の発砲を中止しました',detail:event.reason ?? '',duration:3500,label:'狩人の発砲',day:event.day});
  }
  if (!nightFollowed) events.filter(e => ['attack','injection'].includes(e.kind)).forEach(follow);
  if (current.phase === 'finished' && previous.phase !== 'finished' && current.winner) frames.push({id:'victory',kind:'victory',title:`${current.winner === 'village' ? '村側' : '人狼側'}の勝利！`,detail:current.winner === 'village' ? '生存している人狼が0人になりました。' : '生存人狼が、生存人間と同数以上になりました。',duration:5000,label:'勝敗が決まりました',team:current.winner});
  return frames;
}

// An explicit solo-only replay starts at the latest vote or night, not the whole match.
export function latestResultFrames(current: PublicGame, name: (id: string) => string): ResultFrame[] {
  const events = current.publicLog ?? [];
  const direct = ['execution','noExecution','attack','injection','noVictim'];
  let start = events.findLastIndex(e => direct.includes(e.kind));
  const nightKinds = ['attack','injection','noVictim'];
  const night = start >= 0 && nightKinds.includes(events[start]!.kind);
  if (night) {
    const day = events[start]!.day;
    while (start > 0 && events[start-1]!.day === day && nightKinds.includes(events[start-1]!.kind)) start--;
  }
  return resultFrames({...current, phase:night ? 'night' : 'vote', winner:null, publicLog:start < 0 ? events : events.slice(0,start)}, current, name);
}
