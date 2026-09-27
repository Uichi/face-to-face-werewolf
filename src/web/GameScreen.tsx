import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room } from './types.ts';
import { roleNames } from './types.ts';
import { gameCommand, GameError } from './game-api.ts';
import type { GameResponse, GameView } from './game-api.ts';
import { requestId } from './invite.ts';
import { watchRoom } from './api.ts';
import GameResult from './GameResult.tsx';
import { teamOf } from '../domain/rules.ts';
import type { Role } from '../domain/rules.ts';

type Pending = { action: string; payload: Record<string, unknown> };
const phaseNames = { roles: '役職を確認', firstNight: '最初の夜', discussion: '昼の議論', vote: '投票', runoff: '決選投票', execution: '投票の結果', night: '夜の行動', morning: '朝になりました', finished: '試合終了' };
const roleDetails: Record<Role, string> = {
 villager: 'あなたは村側です。仲間と話し合い、人狼を見つけましょう。夜は確認だけ行います。',
 wolf: 'あなたは人狼側です。夜に人狼以外の1人を選んで襲撃します。狂人を襲撃することもあります。仲間と選択が分かれたときは、選ばれた人の中から無作為に決まります。',
 seer: 'あなたは村側です。夜に自分以外の1人が人狼かどうかを調べられます。',
 medium: 'あなたは村側です。処刑された人が人狼かどうかを、処刑後に確認できます。',
 madman: 'あなたは人狼側の人間です。会話で人狼を助けましょう。人狼が誰かは分からず、人狼にもあなたの正体は分かりません。占い・霊媒では人狼ではないと出ます。夜は確認だけ行います。人数判定では人間として数えます。',
 knight: 'あなたは村側です。夜に自分以外の1人を護衛します。同じ人を続けて護衛できます。',
};

export default function GameScreen({ room, onRoom, onHome }: { room: Room; onRoom: (room: Room) => void; onHome: () => void }) {
 const [game, setGame] = useState<GameView | null>(null);
 const [error, setError] = useState('');
 const [offline, setOffline] = useState(false);
 const [busy, setBusy] = useState(false);
 const [revealed, setRevealed] = useState(false);
 const [roleSeen, setRoleSeen] = useState(false);
 const [clock, setClock] = useState(Date.now());
 const [offset, setOffset] = useState(0);
 const [pending, setPending] = useState<Pending | null>(null);
 const [dialog, setDialog] = useState<{ text: string; action: string; targetId?: string } | null>(null);
 const sending = useRef(false);
 const polling = useRef(false);
 const active = useRef(true);
 const lastRevision = useRef(-1);
 const gameRef = useRef<GameView | null>(null);
 const me = room.viewerId;
 const apply = useCallback((result: GameResponse) => {
   if (!active.current || result.room.revision < lastRevision.current) return;
   lastRevision.current = result.room.revision;
   setOffset(result.serverNow - Date.now());
   gameRef.current = result.game; setGame(result.game); onRoom(result.room);
   setOffline(false);
 }, [onRoom]);
 const refresh = useCallback(async () => {
   if (polling.current || sending.current || document.visibilityState === 'hidden') return;
   polling.current = true;
   try { apply(await gameCommand('get', { roomId: room.id })); }
   catch (e) { if (active.current) { setOffline(true); if (!gameRef.current) setError((e as Error).message); } }
   finally { polling.current = false; }
 }, [room.id, apply]);
 useEffect(() => {
   active.current = true; void refresh();
   const tick = setInterval(() => { setClock(Date.now()); }, 500);
   const poll = setInterval(() => { void refresh(); }, 2000);
   const stop = watchRoom(room.id, () => { void refresh(); });
   const visible = () => { if (document.visibilityState !== 'visible') setRevealed(false); else void refresh(); };
   const blur = () => setRevealed(false);
   document.addEventListener('visibilitychange', visible); window.addEventListener('blur', blur); window.addEventListener('online', visible);
   return () => { active.current = false; clearInterval(tick); clearInterval(poll); stop(); document.removeEventListener('visibilitychange', visible); window.removeEventListener('blur', blur); window.removeEventListener('online', visible); };
 }, [refresh, room.id]);
 useEffect(() => { setRevealed(false); setDialog(null); setPending(null); setError(''); }, [game?.public.id, game?.public.phaseId]);
 useEffect(() => { if (!revealed) return; const timer=setTimeout(() => setRevealed(false), 20_000); return () => clearTimeout(timer); }, [revealed]);

 async function send(action: string, extra: Record<string, unknown> = {}, retry?: Pending) {
   if (sending.current || !gameRef.current) return;
   const current = gameRef.current;
   const command = retry ?? { action, payload: { roomId: room.id, gameId: current.public.id, phaseId: current.public.phaseId, requestId: requestId(), ...extra } };
   sending.current = true; setBusy(true); setError(''); setDialog(null);
   if (action !== 'select') setRevealed(false);
   try { apply(await gameCommand(command.action, command.payload)); setPending(null); }
   catch (e) {
     if (active.current) { setError((e as Error).message); setPending(e instanceof GameError && e.retryable ? command : null); }
   } finally { sending.current = false; if (active.current) setBusy(false); void refresh(); }
 }
 if (!game) return <section className="panel game-loading"><h1>試合に接続しています</h1><p role="status">{error || '少しお待ちください。'}</p><button className="primary" onClick={() => void refresh()}>再接続</button></section>;
 const pub=game.public, priv=game.private;
 const self=pub.players.find(p=>p.id===me)!;
 const host=pub.hostId===me;
 const phase=pub.phase;
 const alive=pub.players.filter(p=>p.alive);
 const name=(id:string|null|undefined)=>room.members.find(m=>m.id===id)?.nickname ?? '参加者';
 const seconds=pub.deadline===null?null:Math.max(0,Math.ceil((pub.deadline-clock-offset)/1000));
 const role=priv?.role;
 const vote=phase==='vote'||phase==='runoff';
 const night=phase==='night';
 const ability=role && ['wolf','seer','knight'].includes(role);
 const candidates=alive.filter(p=>p.id!==me && (phase!=='runoff'||pub.runoffIds.includes(p.id)) && !(night && role==='wolf' && game.wolves?.memberIds.includes(p.id)));
 const canSelect=self.alive && (vote || (night && ability)) && !priv?.confirmed;
 const openPrivate=()=>{setRevealed(!revealed);setRoleSeen(true);};
 const selector = <div className="target-grid" role="group" aria-label={vote?'投票先':'能力の対象'}>{candidates.map(p=><button key={p.id} className={`target-button ${priv?.selection===p.id?'selected':''}`} aria-pressed={priv?.selection===p.id} disabled={busy||!!pending} onClick={()=>void send('select',{targetId:p.id})}>{name(p.id)}<span>{priv?.selection===p.id?'選択中':'選ぶ'}</span></button>)}</div>;
 const confirmButton = <button className="primary" disabled={busy||!!pending||!!priv?.confirmed||((vote||(night&&ability))&&!priv?.selection)||(phase==='roles'&&!roleSeen)} onClick={()=> {
   if(vote||(night&&ability))setDialog({text:`${name(priv?.selection)}さんで確定しますか？ 確定後は変更できません。`,action:'confirm'});
   else void send('confirm');
 }}>{priv?.confirmed?'確認済み・みんなを待っています':busy?'送信中…':vote?'この人への投票を確定':night&&ability?'この対象で確定':phase==='roles'?'役職を確認しました':'夜の確認を完了'}</button>;

 return <div className={`game-screen ${phase==='night'||phase==='firstNight'?'night-screen':''}`}>
   <div className="game-top"><div><div className="section-number">{pub.day}日目 · {alive.length}人生存</div><h1>{phaseNames[phase]}</h1></div>{seconds!==null&&<div className="game-timer" role="timer" aria-label={`残り${seconds}秒`}><strong>{Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</strong><small>{seconds===0?'操作を待っています':'残り時間'}</small></div>}</div>
   {offline&&<div className="message" role="status">接続を確認しています。操作の結果を確認できるまで、このままお待ちください。</div>}
   {error&&<div className="message error" role="alert">{error}{pending&&<button className="text-button" disabled={busy} onClick={()=>void send(pending.action,{},pending)}>同じ操作を再送する</button>}</div>}
   {phase!=='finished'&&pub.removals.length>0&&<div className="inline-note">途中脱落：{pub.removals.map(r=>`${name(r.playerId)}さん（${r.day}日目）`).join('、')}</div>}
   {!self.alive&&phase!=='finished'&&<div className="spectator-note">あなたは脱落しました。発言・投票・能力使用はせず、静かに見守ってください。</div>}
   {phase==='finished'?<GameResult game={pub} room={room}>{host?<button className="primary" disabled={busy} onClick={()=>setDialog({text:'同じメンバー・設定で待機室に戻ります。前の試合の役職や行動は引き継ぎません。',action:'rematch'})}>同じメンバーで再戦</button>:<p className="muted">主催者が再戦を選ぶと、待機室に戻ります。</p>}<div className="result-exit"><button className="secondary-button" disabled={busy} onClick={onHome}>トップへ戻る</button><p>新しい部屋をつくる・別の部屋に参加する</p></div></GameResult>:<>
     {priv&&<section className="panel private-panel"><div className="panel-heading"><h2>あなただけの情報</h2><button className="text-button" aria-expanded={revealed} onClick={openPrivate}>{revealed?'隠す':'タップして表示'}</button></div>{!revealed?<p className="muted">周りに画面を見せないように確認してください。</p>:<div className="secret-content"><span className="role-team">{teamOf(priv.role)==='wolves'?'人狼側':'村側'}</span><h2 className="your-role">{roleNames[priv.role]}</h2><p>{roleDetails[priv.role]}</p>
       {game.wolves&&<div className="secret-box"><strong>人狼の仲間</strong><p>{game.wolves.memberIds.filter(id=>id!==me).map(name).join('、')||'あなた1人です。'}</p>{night&&game.wolves.selections.map(s=><p key={s.actorId}>{name(s.actorId)}：{s.targetId?name(s.targetId):'未選択'}</p>)}</div>}
       {priv.results.length>0&&<div className="secret-box"><strong>能力の結果</strong>{priv.results.map((r,i)=><p key={i}>{r.kind==='initial'?'初夜':`${r.day}日目 ${r.kind==='medium'?'霊媒':'占い'}`} · {name(r.targetId)}さんは<strong>{r.isWolf?'人狼です':'人狼ではありません'}</strong></p>)}</div>}
       {night&&canSelect&&<><h3>{role==='wolf'?'襲撃する人':role==='seer'?'占う人':'護衛する人'}を選ぶ</h3>{selector}</>}
       {night&&confirmButton}
       <small>20秒後、または画面を離れたときに自動で隠れます。</small>
     </div>}</section>}
     <section className="panel phase-panel">
       {phase==='roles'&&<><h2>役職を確認しましょう</h2><p>上の「タップして表示」で自分の役職を確認してから、確認完了を押してください。</p>{self.alive&&confirmButton}</>}
       {phase==='firstNight'&&<><h2>最初の夜です</h2><p>今夜は襲撃・護衛はありません。自分の情報を確認したら、夜の確認を完了してください。</p>{self.alive&&confirmButton}</>}
       {phase==='discussion'&&<><h2>顔を上げて、話し合おう。</h2><p>誰が人狼なのか、気になった発言や考えを共有しましょう。時間になると投票へ進みます。</p></>}
       {vote&&<><h2>{phase==='runoff'?'同票の候補者から選んでください':'投票する人を選んでください'}</h2><p>自分以外の生存者に投票します。確定後は変更できません。</p>{canSelect&&selector}{self.alive&&confirmButton}</>}
       {night&&<><h2>静かに、夜の行動を。</h2><p>生存者全員が「あなただけの情報」を開き、操作を完了してください。能力がない人も確認が必要です。全員が完了すると、残り時間に関係なく朝へ進みます。</p>{priv?.confirmed&&<p className="complete-note">操作は完了しています。みんなを待ちましょう。</p>}</>}
       {phase==='execution'&&<><h2>{pub.voteResult?.executedId?`${name(pub.voteResult.executedId)}さんが処刑されました`:'同票のため、処刑はありません'}</h2><p>脱落した人の役職は、試合終了まで公開されません。</p></>}
       {phase==='morning'&&<><h2>{pub.victimId?`${name(pub.victimId)}さんが犠牲になりました`:'今朝の犠牲者はいません'}</h2><p>結果を確認したら、次の議論に進みましょう。</p></>}
       {['roles','firstNight','vote','runoff','night'].includes(phase)&&<div className="completion"><span>操作完了</span><strong>{pub.completedCount} / {pub.requiredCount}人</strong><progress value={pub.completedCount} max={pub.requiredCount}/></div>}
       {seconds===0&&['vote','runoff','night'].includes(phase)&&<p className="inline-note">時間は終了しましたが、操作は引き続き受け付けています。自動で投票や能力使用はしません。</p>}
       {pub.voteResult&&['runoff','execution'].includes(phase)&&<div className="vote-counts"><h3>得票数</h3>{Object.entries(pub.voteResult.counts).map(([id,n])=><div key={id}><span>{name(id)}</span><b>{n}票</b></div>)}</div>}
     </section>
     <section className="panel"><div className="panel-heading"><h2>参加者</h2><span>{alive.length}人生存</span></div><div className="game-players">{pub.players.map(p=><div className={p.alive?'':'eliminated'} key={p.id}><span>{name(p.id)}{p.id===me?'（あなた）':''}</span><small>{p.alive?'生存':'脱落'}</small></div>)}</div></section>
     {host&&<section className="panel host-controls"><h2>主催者の操作</h2><div className="host-actions">
       {['discussion','vote','runoff','night'].includes(phase)&&<button className="secondary-button" disabled={busy} onClick={()=>void send('extend')}>60秒延長する</button>}
       {phase==='discussion'&&<button className="secondary-button" disabled={busy} onClick={()=>setDialog({text:'議論を終了して、投票に進みますか？',action:'startVote'})}>投票へ進む</button>}
       {['execution','morning'].includes(phase)&&<button className="primary" disabled={busy} onClick={()=>void send('next')}>次へ進む</button>}
     </div><details><summary>復帰できない参加者がいるとき</summary><p>対象者を脱落扱いにします。投票・夜の操作中は全員の操作を取り消し、その段階をやり直します。</p>{alive.map(p=><button className="remove-player" disabled={busy} key={p.id} onClick={()=>setDialog({text:`${name(p.id)}さんを脱落扱いにしますか？ この試合には復帰できません。`,action:'remove',targetId:p.id})}>{name(p.id)}さんを脱落扱いにする</button>)}</details></section>}
     {!host&&['execution','morning'].includes(phase)&&<p className="muted">主催者が「次へ進む」を押すまでお待ちください。</p>}
   </>}
   {dialog&&<Confirmation onClose={()=>setDialog(null)}><h2 id="confirm-title">確認してください</h2><p>{dialog.text}</p><button className="primary" autoFocus disabled={busy} onClick={()=>void send(dialog.action,dialog.targetId?{targetId:dialog.targetId}:{})}>確定する</button><button className="secondary-button" onClick={()=>setDialog(null)}>戻る</button></Confirmation>}
 </div>;
}

function Confirmation({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
 const ref = useRef<HTMLDialogElement>(null);
 useEffect(() => { const node=ref.current; node?.showModal(); return () => node?.close(); }, []);
 return <dialog className="confirm-dialog" ref={ref} aria-labelledby="confirm-title" onCancel={onClose}>{children}</dialog>;
}
