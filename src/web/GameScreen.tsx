import { morningEvents } from './morning-events.ts';
import VoteCounts from './VoteCounts.tsx';
import { canChooseNoExecution } from './no-execution-choice.ts';
import { canHighlightEndurance } from './endurance-highlight.ts';
import HunterEffect from './HunterEffect.tsx';
import ThiefExchangeCards from './ThiefExchangeCards.tsx';
import HostControls from './HostControls.tsx';
import BreadImage from './BreadImage.tsx';
import ActionSelection from './ActionSelection.tsx';
import { actionAdvice, actionChoice, breadNames } from './action-choice.ts';
import ResultPresentation from './ResultPresentation.tsx';
import RoleRevealCard from './RoleRevealCard.tsx';
import { claimRoleReveal } from './role-reveal.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room } from './types.ts';
import { roleNames } from './types.ts';
import { gameCommand, GameError } from './game-api.ts';
import type { GameResponse, GameView } from './game-api.ts';
import { requestId } from './invite.ts';
import { watchRoom } from './api.ts';
import { currentTask } from './current-task.ts';
import GameResult from './GameResult.tsx';
import PublicLog from './PublicLog.tsx';
import { NO_EXECUTION_ID, teamOf } from '../domain/rules.ts';
import type { Role } from '../domain/rules.ts';
import { BREAD_TYPES } from '../domain/game.ts';
import type { BreadType } from '../domain/game.ts';

type Pending = { action: string; payload: Record<string, unknown> };
const phaseNames = { roles: '役職を確認', firstNight: '最初の夜', discussion: '昼の議論', vote: '投票', runoff: '決選投票', execution: '投票の結果', night: '夜の行動', morning: '朝になりました', hunter: '狩人の最後の発砲', finished: '試合終了' };
const roleDetails: Record<Role, string> = {
 shishimai: 'あなたは第三陣営です。初夜から福を配れます。試合中1回だけ、同じ夜に2人に配れます。終了時に生き残り、自分以外の生存者全員に福を配っていれば、勝利陣営と一緒に勝利します。',
 bodybuilder: 'あなたは村側です。試合中1回だけ、人狼の襲撃に自動で耐えます。騎士・医者が守った場合は消費しません。処刑・発砲・2回目の注射・後追いには耐えられません。夜は確認だけ行います。',
 doctor: 'あなたは村側です。自分を含む1人に注射するか、注射しないを選べます。1回目はその夜の襲撃を防ぎ、誰からでも試合中2回目の注射で死亡します。初夜は注射しません。',
 hunter: 'あなたは村側です。処刑・襲撃・2回目の注射で死亡すると、生存者1人を必ず選んで撃ちます。護衛では防げません。途中退場では発動しません。',
 villager: 'あなたは村側です。仲間と話し合い、人狼を見つけましょう。夜は確認だけ行います。',
 wolf: 'あなたは人狼側です。夜に自分以外の生存者と希望度を選びます。仲間も襲撃でき、希望度の合計が最大の人が襲撃されます。',
 seer: 'あなたは村側です。夜に自分以外の1人が人狼かどうかを調べられます。',
 medium: 'あなたは村側です。処刑された人が人狼かどうかを、処刑後に確認できます。',
 lover: 'あなたは村側の恋人です。もう1人の恋人を確認できます。片方が処刑・襲撃・途中退場で脱落すると、もう片方も後追いで脱落します。夜は確認だけ行います。',
 baker: 'あなたは村側のパン屋です。初夜と毎晩、届けるパンを選びます。襲撃された夜のパンは届きません。あなたの名前は公開されません。',
 fanatic: 'あなたは人狼側の人間です。初夜から人狼の名前が分かります。人狼にあなたの正体は通知されません。襲撃には参加せず、夜は確認だけ行います。占い・霊媒では人狼ではないと出ます。',
 madman: 'あなたは人狼側の人間です。会話で人狼を助けましょう。人狼が誰かは分からず、人狼にもあなたの正体は分かりません。占い・霊媒では人狼ではないと出ます。夜は確認だけ行います。人数判定では人間として数えます。',
 knight: 'あなたは村側です。夜に自分以外の1人を護衛します。連続護衛できるかは部屋の設定に従います。',
 thief: 'あなたは村側です。役職確認中に自分以外の1人を選び、その人の役職・陣営・能力・勝利条件を奪います。結果は最初の夜に確認できます。',
};

export type LocalGameDriver = { response: GameResponse; command: (action: string, payload: Record<string, unknown>) => Promise<GameResponse> };

export default function GameScreen({ room, onRoom, onHome, helpOpen = false, localDriver }: { helpOpen?: boolean; room: Room; onRoom: (room: Room) => void; onHome: () => void; localDriver?: LocalGameDriver }) {
 const [game, setGame] = useState<GameView | null>(localDriver?.response.game ?? null);
 const [error, setError] = useState('');
 const [offline, setOffline] = useState(false);
 const [busy, setBusy] = useState(false);
 const [sendingTarget, setSendingTarget] = useState<string | null>(null);
 const [revealed, setRevealed] = useState(false);
 const [blessingVideo, setBlessingVideo] = useState(false);
 const [flipping, setFlipping] = useState(false);
 const [thiefMotion, setThiefMotion] = useState(false);
 const [enduranceGlow, setEnduranceGlow] = useState(false);
 const finishThief=useCallback(()=>setThiefMotion(false),[]);
 const [roleSeen, setRoleSeen] = useState(false);
 const finishReveal=useCallback(()=>{setFlipping(false);setRoleSeen(true);},[]);
 const [wolfStrength, setWolfStrength] = useState<1|2|3>(2);
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
 useEffect(() => { const strength=game?.private?.attackStrength; setWolfStrength(strength===1||strength===2||strength===3?strength:2); }, [game?.public.id, game?.public.phaseId, game?.private?.attackStrength]);
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
   try { apply(localDriver ? localDriver.response : await gameCommand('get', { roomId: room.id })); }
   catch (e) { if (active.current) { setOffline(true); if (!gameRef.current) setError((e as Error).message); } }
   finally { polling.current = false; }
 }, [room.id, apply, localDriver]);
 useEffect(() => {
   active.current = true; void refresh();
   const tick = setInterval(() => { setClock(Date.now()); }, 500);
   const poll = localDriver ? 0 : window.setInterval(() => { void refresh(); }, 2000);
   const stop = localDriver ? () => {} : watchRoom(room.id, () => { void refresh(); });
   const conceal = () => { setRevealed(false); setDialog(value => value?.action === 'confirm' ? null : value); };
   const visible = () => { if (document.visibilityState !== 'visible') conceal(); else void refresh(); };
   const blur = conceal;
   document.addEventListener('visibilitychange', visible); window.addEventListener('blur', blur); window.addEventListener('online', visible);
   return () => { active.current = false; clearInterval(tick); if (poll) clearInterval(poll); stop(); document.removeEventListener('visibilitychange', visible); window.removeEventListener('blur', blur); window.removeEventListener('online', visible); };
 }, [refresh, room.id, localDriver]);
 useEffect(() => { if (localDriver) apply(localDriver.response); }, [localDriver?.response, apply, localDriver]);
 useEffect(() => { setRevealed(false); setFlipping(false); setThiefMotion(false); setEnduranceGlow(false); setDialog(null); setPending(null); setError(''); if (game?.public.phase !== 'finished') window.scrollTo({ top: 0, behavior: 'instant' }); }, [game?.public.id, game?.public.phaseId]);
 useEffect(() => { if (helpOpen) { setRevealed(false); setDialog(value => value?.action === 'confirm' ? null : value); } }, [helpOpen]);
 useEffect(() => { if (!revealed) return; const timer=setTimeout(() => { setRevealed(false); setDialog(value => value?.action === 'confirm' ? null : value); }, 20_000); return () => clearTimeout(timer); }, [revealed]);

 async function send(action: string, extra: Record<string, unknown> = {}, retry?: Pending) {
   if (sending.current || !gameRef.current) return;
   const current = gameRef.current;
   const command = retry ?? { action, payload: { roomId: room.id, gameId: current.public.id, phaseId: current.public.phaseId, requestId: requestId(), ...extra } };
   sending.current = true; setBusy(true); setError(''); setDialog(null);
   setSendingTarget(command.action === 'select' && typeof command.payload.targetId === 'string'
     ? command.payload.targetId : null);
   if (action !== 'select') setRevealed(false);
   try { apply(await (localDriver ? localDriver.command(command.action, command.payload) : gameCommand(command.action, command.payload))); setPending(null); }
   catch (e) {
     if (active.current) { const strength=gameRef.current?.private?.attackStrength; setWolfStrength(strength===1||strength===2||strength===3?strength:2); setError((e as Error).message); setPending(e instanceof GameError && e.retryable ? command : null); }
   } finally { sending.current = false; if (active.current) { setBusy(false); setSendingTarget(null); } if (!localDriver) void refresh(); }
 }
 if (!game) return <section className="panel game-loading"><h1>試合に接続しています</h1><p role="status">{error || '少しお待ちください。'}</p><button className="primary" onClick={() => void refresh()}>再接続</button></section>;
 const pub=game.public, priv=game.private;
 const self=pub.players.find(p=>p.id===me)!;
 const host=pub.hostId===me;
 const phase=pub.phase;
 const alive=pub.players.filter(p=>p.alive);
 const name=(id:string|null|undefined)=>id===NO_EXECUTION_ID?'誰も処刑しない':room.members.find(m=>m.id===id)?.nickname ?? '参加者';
 const seconds=pub.deadline===null?null:Math.max(0,Math.ceil((pub.deadline-clock-offset)/1000));
 const role=priv?.role;
 const hunterShot=phase==='hunter' && pub.hunter?.actorId===me;
 const vote=phase==='vote'||phase==='runoff';
 const phaseTone = vote || phase === 'execution' ? 'vote'
   : phase === 'night' || phase === 'firstNight' ? 'night'
   : phase === 'morning' ? 'morning'
   : phase === 'discussion' ? 'day' : undefined;
 const night=phase==='night';
 const resultPhase=phase==='execution'||phase==='morning';
 const voteCounts = pub.voteResult?.counts;
 const highestVotes = Math.max(0, ...Object.values(voteCounts ?? {}));
 const noExecutionWon = !pub.voteResult?.executedId && voteCounts?.[NO_EXECUTION_ID] === highestVotes
   && Object.values(voteCounts ?? {}).filter(count => count === highestVotes).length === 1;
 const directlyEliminatedId = pub.voteResult?.executedId;
 const task=currentTask({resultConfirmation:pub.resultConfirmation===true,phase,alive:self.alive,confirmed:!!priv?.confirmed,selected:!!priv?.selection,roleSeen,busy,retryPending:!!pending,offline,hunterActor:hunterShot});
 const ability=role && ['wolf','seer','knight','doctor'].includes(role);
 const breadChoice=!!(room.breadChoices||localDriver)&&role==='baker'&&(phase==='firstNight'||phase==='night');
 const thiefChoice=phase==='roles'&&role==='thief';
 const candidates=alive.filter(p=>(p.id!==me || night&&role==='doctor') && (phase!=='runoff'||pub.runoffIds.includes(p.id)));
 const canVoteNoExecution=canChooseNoExecution(room,phase,pub.day,pub.runoffIds,!!localDriver);
 const canSelect=(self.alive || hunterShot) && (hunterShot || vote || thiefChoice || (night && ability) || breadChoice) && !priv?.confirmed;
 const blockedGuardId=night&&role==='knight'&&(pub.consecutiveGuard??room.consecutiveGuard)===false?priv?.lastGuardTargetId:null;
 const blessingNight = role === 'shishimai' && (phase === 'firstNight' || night);
 const blessingCandidates = candidates.filter(p => !priv?.blessing?.deliveredIds.includes(p.id));
 const blessingIds: string[] = blessingNight && priv?.selection ? JSON.parse(priv.selection) : [];
 const blessingNames = blessingIds.map(id => name(id) + 'さん').join('、');
 const choice=blessingNight ? (blessingIds.length ? {
   selected: `${blessingNames}に福を配ります`, accepted: `${blessingNames}への福配りを確定しました`, question: `${blessingNames}に福を配りますか？`, button: '福配りを確定',
 } : null) : priv ? actionChoice(phase,role,priv.selection,id=>name(id),priv.attackStrength) : null;
 const selectionCard=choice&&priv ? <ActionSelection choice={choice} confirmed={priv.confirmed} busy={busy} pending={!!pending} offline={offline} failed={!!error}/> : null;
 const advice=actionAdvice(hunterShot?'hunter':role,pub.consecutiveGuard??room.consecutiveGuard);
 const openPrivate=()=>{
   if(revealed){setRevealed(false);setFlipping(false);setDialog(value=>value?.action==='confirm'?null:value);return;}
   let storage: Storage | undefined;
   try { storage=window.localStorage; } catch { /* Keep working in private browsing. */ }
   const first=claimRoleReveal(pub.id,me,storage);
   const exchangeFirst=!!priv?.thiefExchange?.targetId&&claimRoleReveal(pub.id+':thief-exchange',me,storage);
   const enduranceFirst=canHighlightEndurance(game,me)&&claimRoleReveal(pub.id+':private-highlight',me,storage);
   const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
   setBlessingVideo(!reduced && !!priv?.blessingReceived && claimRoleReveal(pub.id + ':blessing', me, storage));
   setEnduranceGlow(enduranceFirst&&!reduced);
   setThiefMotion(exchangeFirst&&!reduced);
   const animate=first&&!exchangeFirst&&!reduced;
   setFlipping(animate);setRevealed(true);if(!animate)setRoleSeen(true);
 };
 const controlsDisabled = busy || !!pending || offline;
 const targetOptions = [
   ...candidates.map(p => ({ id: p.id, label: name(p.id), blocked: p.id === blockedGuardId })),
   ...(night && role === 'doctor' ? [{ id: '__no_injection__', label: '注射しない', blocked: false }] : []),
   ...(canVoteNoExecution ? [{ id: NO_EXECUTION_ID, label: '誰も処刑しない', blocked: false }] : []),
 ];
 const selector = <div className="target-grid player-targets" role="group" aria-label={vote ? '投票先' : '能力の対象'}>
   {targetOptions.map(({ id, label, blocked }) => {
     const selected = priv?.selection === id;
     const submitting = sendingTarget === id;
     return <button key={id} className={`target-button ${selected ? 'selected' : ''} ${submitting ? 'target-submitting' : ''} ${id === NO_EXECUTION_ID ? 'no-execution' : ''}`}
       aria-pressed={selected} aria-busy={submitting || undefined} disabled={controlsDisabled || blocked}
       onClick={() => void send('select', { targetId: id, ...(night && role === 'wolf' ? { strength: wolfStrength } : {}) })}>
       <span className="target-name">{label}</span>
       {(blocked || selected || submitting) && <span className="target-status">{selected && !submitting && !blocked && <span className="target-check" aria-hidden="true">✓</span>}{submitting ? '送信中…' : blocked ? '前夜に護衛' : '選択中'}</span>}
     </button>;
   })}
 </div>;
 const breadSelector = <div className="target-grid bread-selector" role="group" aria-label="届けるパン">{BREAD_TYPES.map(type=><button key={type} className={`target-button ${priv?.selection===type?'selected':''}`} aria-pressed={priv?.selection===type} disabled={busy||!!pending||offline} onClick={()=>void send('select',{targetId:type})}><BreadImage type={type} compact/>{breadNames[type]}<span>{priv?.selection===type?'選択中':'選ぶ'}</span></button>)}</div>;
 const confirmButton = <button className="primary" disabled={busy||!!pending||offline||!!priv?.confirmed||((hunterShot||vote||thiefChoice||(night&&ability)||breadChoice||(blessingNight&&blessingCandidates.length>0))&&!choice)||(phase==='roles'&&!roleSeen)} onClick={()=> {
   if(choice) setDialog({text:choice.question,action:'confirm'});
   else void send('confirm');
 }}>{priv?.confirmed?'確定済み・みんなを待っています':busy?'送信中…':pending?'送信結果を確認中':offline?'再接続を待っています':choice?.button??(hunterShot?'この人への発砲を確定':vote?'投票先を選んでください':breadChoice?'このパンを焼く':night&&ability?'行動の対象を選んでください':thiefChoice?'この人の役職を奪う':phase==='roles'?'役職を確認しました':resultPhase?'結果を確認しました':'夜の確認を完了')}</button>;

 return <ResultPresentation game={pub} room={room} paused={offline || helpOpen} allowReplay={!!localDriver}><div className={`game-screen ${phase==='night'||phase==='firstNight'?'night-screen':''}`}>
   <div className="game-top" data-phase-tone={phaseTone} key={phase}><div><div className="section-number">{pub.day}日目 · {alive.length}人生存</div><h1><span>{phaseNames[phase]}</span></h1></div>{seconds!==null&&<div className="game-timer" data-urgency={seconds===0?'ended':seconds!==null&&seconds<=10?'urgent':seconds!==null&&seconds<=30?'soon':'normal'} role="timer" aria-label={`残り${seconds}秒`}><strong>{Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</strong><small>{seconds===0?'操作を待っています':'残り時間'}</small></div>}</div>
   {phase!=='finished'&&<aside className={`current-task ${task.waiting?'task-waiting':''}`} aria-live="polite" aria-atomic="true"><span>今やること</span><h2>{task.title}</h2><p>{task.detail}</p></aside>}
   {offline&&<div className="message" role="status">接続を確認しています。操作の結果を確認できるまで、このままお待ちください。</div>}
   {error&&<div className="message error" role="alert">{error}{pending&&<button className="text-button" disabled={busy} onClick={()=>void send(pending.action,{},pending)}>同じ操作を再送する</button>}</div>}
   {phase!=='finished'&&pub.removals.length>0&&<div className="inline-note">途中脱落：{pub.removals.map(r=>`${name(r.playerId)}さん（${r.day}日目）`).join('、')}</div>}
   {!self.alive&&!hunterShot&&phase!=='finished'&&<div className="spectator-note">あなたは脱落しました。発言・投票・能力使用はせず、静かに見守ってください。</div>}
   {phase==='finished'?<GameResult game={pub} room={room} personalNotice={game.personalNotice}>{game.personalNotice?.kind==='endurance'&&<p className="inline-note" role="status">あなただけへの通知：{game.personalNotice.day}日目の夜、筋肉で襲撃に耐えました。襲撃への耐久は使用済みです。</p>}{host?<button className="primary" disabled={busy} onClick={()=>setDialog({text:'同じメンバー・設定で待機室に戻ります。前の試合の役職や行動は引き継ぎません。',action:'rematch'})}>同じ設定で再戦（待機室へ）</button>:<p className="muted">主催者が再戦を選ぶと、待機室に戻ります。</p>}<div className="result-exit"><button className="secondary-button" disabled={busy} onClick={onHome}>トップへ戻る</button><p>新しい部屋をつくる・別の部屋に参加する</p></div></GameResult>:<>
     {priv&&<section className="panel private-panel"><div className="panel-heading"><h2>あなただけの情報</h2><button className="text-button" aria-expanded={revealed} onClick={openPrivate}>{revealed?'隠す':'タップして表示'}</button></div>{!revealed?<><p className="muted">周りに画面を見せないように確認してください。</p>{priv.endurance?.used&&phase==='morning'&&priv.endurance.day===pub.day-1&&<p role="status">新しいお知らせがあります。「タップして表示」で確認してください。</p>}</>:<div className="secret-content">
       {priv.blessingReceived && <div className="secret-box">
         <strong role="status">獅子舞から福を授かりました。</strong>
         {blessingVideo && !flipping && !thiefMotion && <>
           <video className="bread-delivery-video" aria-label="獅子舞から福を授かる動画"
             autoPlay muted playsInline src="/videos/shishimai-blessing.mp4"
             onEnded={() => setBlessingVideo(false)} onError={() => setBlessingVideo(false)} />
           <button className="secondary-button" onClick={() => setBlessingVideo(false)}>動画をスキップ</button>
         </>}
       </div>}
       {priv.confirmed && vote && <div hidden={flipping}>{selectionCard}</div>}{thiefMotion&&priv.thiefExchange?.targetId?<ThiefExchangeCards thiefName="あなた" targetName={name(priv.thiefExchange.targetId)+'さん'} stolenRole={priv.thiefExchange.stolenRole} animate privateView onComplete={finishThief}/>:<RoleRevealCard role={priv.role} animate={flipping} highlight={enduranceGlow} onComplete={finishReveal}/>}<div hidden={flipping||thiefMotion}><span className="role-team">{priv.role==='shishimai'?'第三陣営':teamOf(priv.role)==='wolves'?'人狼側':'村側'}</span><h2 className="your-role">{roleNames[priv.role]}</h2>{night ? <details className="night-role-help"><summary>役職の説明</summary><p>{roleDetails[priv.role]}</p></details> : <p>{roleDetails[priv.role]}</p>}
       {(night || breadChoice || thiefChoice || blessingNight) && <section className="night-action" aria-labelledby="night-action-title">
         <h3 id="night-action-title">{thiefChoice ? '役職を奪う'
           : breadChoice ? '届けるパンを選ぶ'
           : blessingNight ? '福を配る'
           : role === 'wolf' ? '襲撃先を選ぶ'
           : role === 'seer' ? '占う人を選ぶ'
           : role === 'knight' ? '護衛先を選ぶ'
           : role === 'doctor' ? '注射する人を選ぶ'
           : '夜の確認'}</h3>
         {!priv.confirmed && night && advice && <p className="inline-note action-advice">{advice}</p>}
         {!priv.confirmed && night && !ability && !breadChoice && !blessingNight && <p>今夜は確認を押すと完了です。</p>}
         {thiefChoice && canSelect && <p>交換はほかの人には知らされません。確定後は変更できません。</p>}
         {canSelect && (thiefChoice || night && ability) && selector}
         {night && canSelect && role === 'wolf' && <div className="strength-picker" role="group" aria-label="襲撃の希望度">
           {([1,2,3] as const).map(value => <button type="button" className={wolfStrength === value ? 'selected' : ''} aria-pressed={wolfStrength === value} disabled={controlsDisabled} key={value} onClick={() => {
             setWolfStrength(value);
             if (priv.selection) void send('select', { targetId: priv.selection, strength: value });
           }}>{value === 1 ? '弱く希望' : value === 2 ? '希望' : '強く希望'}（{value}）</button>)}
         </div>}
         {breadChoice && canSelect && breadSelector}
       {blessingNight && !priv.confirmed && (blessingCandidates.length ? <div className="target-grid player-targets" role="group" aria-label="福を配る人">
         {blessingCandidates.map(p => {
           const selected = blessingIds.includes(p.id);
           const full = blessingIds.length >= (priv.blessing?.doubleUsed ? 1 : 2);
           return <button key={p.id} className={`target-button ${selected?'selected':''}`} aria-pressed={selected}
             disabled={busy || !!pending || offline} onClick={() => void send('select', {
               targetId: JSON.stringify(selected ? blessingIds.filter(id => id !== p.id) : full ? [p.id] : [...blessingIds, p.id]),
             })}><span className="target-name">{name(p.id)}</span>{selected && <span className="target-status"><span className="target-check" aria-hidden="true">✓</span>選択中</span>}</button>;
         })}
       </div> : <p>生存者には全員に配り終えました。夜の確認を完了してください。</p>)}
         {thiefChoice && priv.confirmed && priv.selection && <div className="thief-waiting"><img src="/images/roles/card-back.png" alt="裏向きのカード" width="1024" height="1536"/><p>{name(priv.selection)}さん → あなた</p></div>}
         {selectionCard}
         {confirmButton}
       </section>}
       {priv.loverId&&<div className="secret-box"><strong>あなたの恋人</strong><p>{name(priv.loverId)}さん</p></div>}
       {priv.thiefExchange?.targetId&&<div className="secret-box thief-result"><strong>怪盗の交換結果</strong><p><b>{name(priv.thiefExchange.targetId)}さん</b>の「{roleNames[priv.thiefExchange.stolenRole]}」を奪いました。</p><p>あなたの現在の役職は<strong>{roleNames[priv.thiefExchange.stolenRole]}</strong>です。</p></div>}
       {priv.fanaticWolfIds && <div className="secret-box"><strong>あなたが知っている人狼</strong><p>{priv.fanaticWolfIds.map(name).join('、') || '該当者はいません。'}</p><small>この一覧はあなたにだけ表示されます。</small></div>}
       {game.wolves&&<div className="secret-box"><strong>人狼の仲間</strong><p>{game.wolves.memberIds.filter(id=>id!==me).map(name).join('、')||'あなた1人です。'}</p><small>仲間が誰を希望したかは表示されません。</small></div>}
       {role==='bodybuilder'&&priv.endurance&&<div className="secret-box" role="status"><strong>襲撃への耐久：{priv.endurance.used?'使用済み':'未使用（残り1回）'}</strong>{priv.endurance.used&&<p>{priv.endurance.day}日目の夜、筋肉で襲撃に耐えました。次の襲撃には耐えられません。</p>}</div>}
       {priv.blessing && <div className="secret-box">
         <strong>福を配った人</strong>
         <p>{priv.blessing.deliveredIds.map(name).join('、') || 'まだ配っていません。'}</p>
         <p>{priv.blessing.doubleUsed ? '二人への福配りは使用済みです。' : '今夜は2人まで選べます。2人に配れるのは試合中1回です。'}</p>
       </div>}
       {role==='doctor' &&<div className="secret-box"><strong>自分の注射履歴</strong><p>誰からでも、試合中に2回注射されると死亡します。他の医者の行動や対象の累計回数は分かりません。</p>{priv.injectionHistory?.map((h,i)=><p key={i}>{h.day}日目：{h.targetId==='__no_injection__'?'注射しない':`${name(h.targetId)}さんに注射`}</p>)}</div>}
       {priv.results.length>0&&<div className="secret-box"><strong>能力の結果</strong>{priv.results.map((r,i)=><p key={i}>{r.kind==='initial'?'初夜':`${r.day}日目 ${r.kind==='medium'?'霊媒':'占い'}`} · {name(r.targetId)}さんは<strong>{r.isWolf?'人狼です':'人狼ではありません'}</strong></p>)}</div>}
       <small>20秒後、または画面を離れたときに自動で隠れます。</small>
     </div></div>}</section>}
     {(phase !== 'discussion' || (pub.day === 1 && pub.breadDelivery?.day === 0) || pub.compositionMode === 'random') && <section className={`panel phase-panel ${vote ? 'vote-panel' : ''}`}>{pub.compositionMode==='random'&&<p className="inline-note">ランダム配役 · 開始時の人狼{pub.fixedWolves}人 · 候補：{pub.randomCandidates?.map(role=>roleNames[role]).join('、')||'なし'}。配役人数は終了まで秘密です。</p>}
       {phase==='hunter'&&<><HunterEffect/><p>{pub.voteResult&&pub.voteResult.executedId===pub.hunter?.actorId?`${name(pub.hunter?.actorId)}さんが${pub.voteResult.counts[pub.hunter!.actorId]??0}票で処刑されました。`:`${name(pub.hunter?.actorId)}さんが夜の処理で脱落しました。`}</p><h2>{name(pub.hunter?.actorId)}さんは狩人でした</h2><p>狩人だったため、最後の発砲を行います。発砲と恋人の後追いを処理してから勝敗を判定します。</p>{hunterShot?<><p>あなたが最後に撃つ生存者1人を選んでください。騎士の護衛では防げません。</p>{advice&&<p className="inline-note action-advice">{advice}</p>}{canSelect&&selector}{!priv?.confirmed&&selectionCard}{confirmButton}</>:<p>狩人本人の選択を待っています。</p>}</>}
       {phase==='roles'&&<>{self.alive&&!thiefChoice&&confirmButton}</>}
       {phase==='firstNight'&&<><p>初夜は襲撃・護衛・占いがありません。</p>{self.alive&&!breadChoice&&!blessingNight&&confirmButton}</>}
       {phase==='discussion'&&<>{pub.day===1&&pub.breadDelivery?.day===0&&<div className="bread-notice delivered" role="status"><BreadImage type={pub.breadDelivery.breadType}/><div><strong>{breadNames[pub.breadDelivery.breadType]}が届きました</strong><p>パン屋が最初の夜に焼いたパンです。パン屋の名前は公開されません。</p></div></div>}</>}
       {vote&&<>{phase === 'runoff' && voteCounts && <div className="vote-outcome">
         <strong>決選投票へ</strong>
         <p>{pub.runoffIds.map(name).join('、')}が{highestVotes}票で同票でした。</p>
       </div>}<p>{canVoteNoExecution?'自分以外の生存者、または「誰も処刑しない」に投票します。':'自分以外の生存者に投票します。'}確定後は変更できません。</p>{canSelect&&selector}{!priv?.confirmed&&selectionCard}{priv?.confirmed&&<p className="complete-note">投票は確定済みです。内容は「あなただけの情報」で確認できます。</p>}{self.alive&&confirmButton}</>}
       {phase==='execution' && <div className="vote-outcome">
         <h2>{pub.voteResult?.executedId ? `${name(pub.voteResult.executedId)}さんが処刑されました` : '誰も処刑されませんでした'}</h2>
         {pub.voteResult?.executedId || noExecutionWon
           ? <strong>{highestVotes}票</strong>
           : <p>{pub.voteResult ? '同票のため、処刑なしです。' : '処刑された人はいません。'}</p>}
       </div>}
       {phase === 'morning' && <>
         <PublicLog events={morningEvents(pub)} room={room} morning />
         {!pub.breadDelivered && ((pub.composition?.baker ?? 0) > 0 || pub.compositionMode === 'random' && pub.randomCandidates?.includes('baker')) &&
           <p className="inline-note">今日はパンが届きませんでした。</p>}
       </>}
       {phase==='execution'&&pub.followedIds?.length>0&&<div className="lover-follow-notice" role="status"><strong>恋人の後追いが発生しました</strong>{pub.followedIds.map(id=><p key={id}>{name(id)}さんは、{name(directlyEliminatedId)}さんの<strong>恋人だったため</strong>、後追いで脱落しました。</p>)}</div>}
       {resultPhase&&pub.resultConfirmation&&<div className="result-confirm"><p>生存者全員の確認で、自動的に次へ進みます。</p>{self.alive&&confirmButton}</div>}
       {(['roles','firstNight','vote','runoff','night'].includes(phase)||(resultPhase&&pub.resultConfirmation))&&<div className="completion"><span>操作完了</span><strong>{pub.completedCount} / {pub.requiredCount}人</strong><progress value={pub.completedCount} max={pub.requiredCount}/></div>}
       {seconds===0&&['vote','runoff','night'].includes(phase)&&<p className="inline-note">時間は終了しましたが、操作は引き続き受け付けています。自動で投票や能力使用はしません。</p>}
       {voteCounts && ['runoff','execution'].includes(phase) && <VoteCounts
         key={pub.phaseId} counts={voteCounts} name={name} runoffIds={phase === 'runoff' ? pub.runoffIds : []} />}
     </section>}
     {host&&<HostControls game={pub} seconds={seconds} disabled={busy||!!pending||offline} hostAlive={self.alive} name={name} onAction={action=>void send(action)} onConfirm={(text,action,targetId)=>setDialog({text,action,targetId})}/>}
     <PublicLog events={pub.publicLog??[]} room={room}/>
     <section className="panel"><div className="panel-heading"><h2>参加者</h2><span>{alive.length}人生存</span></div><div className="game-players">{pub.players.map(p=><div className={p.alive?'':'eliminated'} key={p.id}><span>{name(p.id)}{p.id===me?'（あなた）':''}</span><small>{p.alive?'生存':'脱落'}</small></div>)}</div></section>

   </>}
   {dialog&&<Confirmation onClose={()=>setDialog(null)}><h2 id="confirm-title">確認してください</h2><p>{dialog.text}</p><button className="primary" autoFocus disabled={busy} onClick={()=>void send(dialog.action,dialog.targetId?{targetId:dialog.targetId}:{})}>確定する</button><button className="secondary-button" onClick={()=>setDialog(null)}>戻る</button></Confirmation>}
 </div></ResultPresentation>;
}

function Confirmation({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
 const ref = useRef<HTMLDialogElement>(null);
 useEffect(() => { const node=ref.current; node?.showModal(); return () => node?.close(); }, []);
 return <dialog className="confirm-dialog" ref={ref} aria-labelledby="confirm-title" onCancel={onClose}>{children}</dialog>;
}
