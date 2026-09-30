import type { BreadType, PublicLogEvent } from '../domain/game.ts';
import type { Room } from './types.ts';

export default function PublicLog({ events, room }: { events: PublicLogEvent[]; room: Room }) {
  if (!events.length) return null;
  const name = (id?: string) => room.members.find(member => member.id === id)?.nickname ?? '参加者';
  return <section className="panel public-log" aria-labelledby="public-log-title">
    <div className="panel-heading"><h2 id="public-log-title">公開ログ</h2><span>古い順</span></div>
    <ol>{events.map(event => <li key={event.id}>
      <div className="public-log-day">{event.kind === 'bread' && event.day === 0 ? '最初の夜のパン' : `${event.day}日目${event.kind === 'attack' || event.kind === 'noVictim' ? 'の夜' : event.kind === 'bread' ? 'のパン' : 'の投票'}`}</div>
      {event.kind === 'execution' && <p><strong>{name(event.playerId)}さん</strong>が処刑されました。</p>}
      {event.kind === 'noExecution' && <p><strong>誰も処刑されませんでした。</strong></p>}
      {event.kind === 'attack' && <p><strong>{name(event.playerId)}さん</strong>が人狼の襲撃で犠牲になりました。</p>}
      {event.kind === 'noVictim' && <p><strong>襲撃による犠牲者はいませんでした。</strong></p>}
      {event.kind === 'bread' && event.breadType && <p><strong>{({shokupan:'食パン',croissant:'クロワッサン',melonpan:'メロンパン',currypan:'カレーパン',anpan:'あんパン',surprise:'おまかせ'} satisfies Record<BreadType,string>)[event.breadType]}</strong>が届きました。</p>}
      {event.followedIds?.map(id => <p className="public-log-follow" key={id}><strong>{name(id)}さん</strong>は、{name(event.playerId)}さんの恋人だったため後追いしました。</p>)}
    </li>)}</ol>
  </section>;
}
