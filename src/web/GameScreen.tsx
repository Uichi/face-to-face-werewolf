import RoleImage from './RoleImage.tsx';
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
const breadNames: Record<BreadType,string> = { shokupan:'食パン', croissant:'クロワッサン', melonpan:'メロンパン', currypan:'カレーパン', anpan:'あんパン', surprise:'おまかせ' };
const roleDetails: Record<Role, string> = {
 hunter: 'あなたは村側です。処刑・襲撃で死亡すると、生存者1人を必ず選んで撃ちます。護衛では防げません。途中退場では発動しません。',
 villager: 'あなたは村側です。仲間と話し合い、人狼を見つけましょう。夜は確認だけ行います。',
 wolf: 'あなたは人狼側です。夜に自分以外の生存者と希望度を選びます。仲間も襲撃でき、希望度の合計が最大の人が襲撃されます。',
 seer: 'あなたは村側です。夜に自分以外の1人が人狼かどうかを調べられます。',
 medium: 'あなたは村側です。処刑された人が人狼かどうかを、処刑後に確認できます。',
 lover: 'あなたは村側の恋人です。もう1人の恋人を確認できます。片方が処刑・襲撃・途中退場で脱落すると、もう片方も後追いで脱落します。夜は確認だけ行います。',
 baker: 'あなたは村側のパン屋です。初夜と毎晩、届けるパンを選びます。襲撃された夜のパンは届きません。あなたの名前は公開されません。',
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
 const [revealed, setRevealed] = useState(false);
 const [roleSeen, setRoleSeen] = useState(false);
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
   const visible = () => { if (document.visibilityState !== 'visible') setRevealed(false); else void refresh(); };
   const blur = () => setRevealed(false);
   document.addEventListener('visibilitychange', visible); window.addEventListener('blur', blur); window.addEventListener('online', visible);
   return () => { active.current = false; clearInterval(tick); if (poll) clearInterval(poll); stop(); document.removeEventListener('visibilitychange', visible); window.removeEventListener('blur', blur); window.removeEventListener('online', visible); };
 }, [refresh, room.id, localDriver]);
 useEffect(() => { if (localDriver) apply(localDriver.response); }, [localDriver?.response, apply, localDriver]);
 useEffect(() => { setRevealed(false); setDialog(null); setPending(null); setError(''); if (game?.public.phase !== 'finished') window.scrollTo({ top: 0, behavior: 'instant' }); }, [game?.public.id, game?.public.phaseId]);
 useEffect(() => { if (helpOpen) setRevealed(false); }, [helpOpen]);
 useEffect(() => { if (!revealed) return; const timer=setTimeout(() => setRevealed(false), 20_000); return () => clearTimeout(timer); }, [revealed]);

 async function send(action: string, extra: Record<string, unknown> = {}, retry?: Pending) {
   if (sending.current || !gameRef.current) return;
   const current = gameRef.current;
   const command = retry ?? { action, payload: { roomId: room.id, gameId: current.public.id, phaseId: current.public.phaseId, requestId: requestId(), ...extra } };
   sending.current = true; setBusy(true); setError(''); setDialog(null);
   if (action !== 'select') setRevealed(false);
   try { apply(await (localDriver ? localDriver.command(command.action, command.payload) : gameCommand(command.action, command.payload))); setPending(null); }
   catch (e) {
     if (active.current) { setError((e as Error).message); setPending(e instanceof GameError && e.retryable ? command : null); }
   } finally { sending.current = false; if (active.current) setBusy(false); if (!localDriver) void refresh(); }
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
 const night=phase==='night';
 const resultPhase=phase==='execution'||phase==='morning';
 const noExecutionWon=!!pub.voteResult&&!pub.voteResult.executedId&&pub.voteResult.counts[NO_EXECUTION_ID]===Math.max(...Object.values(pub.voteResult.counts));
 const directlyEliminatedId=phase==='execution'?pub.voteResult?.executedId:phase==='morning'?pub.victimId:null;
 const task=currentTask({resultConfirmation:pub.resultConfirmation===true,phase,alive:self.alive,confirmed:!!priv?.confirmed,selected:!!priv?.selection,roleSeen,busy,retryPending:!!pending,offline,hunterActor:hunterShot});
 const ability=role && ['wolf','seer','knight'].includes(role);
 const breadChoice=!!(room.breadChoices||localDriver)&&role==='baker'&&(phase==='firstNight'||phase==='night');
 const thiefChoice=phase==='roles'&&role==='thief';
 const candidates=alive.filter(p=>p.id!==me && (phase!=='runoff'||pub.runoffIds.includes(p.id)));
 const canVoteNoExecution=!!(room.firstDayNoExecution||localDriver)&&vote&&pub.day===1&&(phase==='vote'||pub.runoffIds.includes(NO_EXECUTION_ID));
 const canSelect=(self.alive || hunterShot) && (hunterShot || vote || thiefChoice || (night && ability) || breadChoice) && !priv?.confirmed;
 const blockedGuardId=night&&role==='knight'&&pub.consecutiveGuard===false?priv?.lastGuardTargetId:null;
 const openPrivate=()=>{setRevealed(!revealed);setRoleSeen(true);};
 const selector = <div className="target-grid" role="group" aria-label={vote?'投票先':'能力の対象'}>{candidates.map(p=>{const blocked=p.id===blockedGuardId;return <button key={p.id} className={`target-button ${priv?.selection===p.id?'selected':''}`} aria-pressed={priv?.selection===p.id} disabled={busy||!!pending||blocked} onClick={()=>void send('select',{targetId:p.id,...(night&&role==='wolf'?{strength:wolfStrength}:{})})}>{name(p.id)}<span>{blocked?'前夜に護衛':priv?.selection===p.id?'選択中':'選ぶ'}</span></button>})}{canVoteNoExecution&&<button className={`target-button no-execution ${priv?.selection===NO_EXECUTION_ID?'selected':''}`} aria-pressed={priv?.selection===NO_EXECUTION_ID} disabled={busy||!!pending} onClick={()=>void send('select',{targetId:NO_EXECUTION_ID})}>誰も処刑しない<span>{priv?.selection===NO_EXECUTION_ID?'選択中':'選ぶ'}</span></button>}</div>;
 const breadSelector = <div className="target-grid bread-selector" role="group" aria-label="届けるパン">{BREAD_TYPES.map(type=><button key={type} className={`target-button ${priv?.selection===type?'selected':''}`} aria-pressed={priv?.selection===type} disabled={busy||!!pending} onClick={()=>void send('select',{targetId:type})}>{breadNames[type]}<span>{priv?.selection===type?'選択中':'選ぶ'}</span></button>)}</div>;
 const confirmButton = <button className="primary" disabled={busy||!!pending||!!priv?.confirmed||((hunterShot||vote||thiefChoice||(night&&ability)||breadChoice)&&!priv?.selection)||(phase==='roles'&&!roleSeen)} onClick={()=> {
   if(hunterShot||vote||thiefChoice||(night&&ability)||breadChoice)setDialog({text:hunterShot?`${name(priv?.selection)}さんを撃ちますか？ 確定すると取り消せません。`:priv?.selection===NO_EXECUTION_ID?'「誰も処刑しない」への投票を確定しますか？ 確定後は変更できません。':breadChoice?`「${breadNames[priv?.selection as BreadType]}」を焼きますか？ 確定後は変更できません。`:thiefChoice?`${name(priv?.selection)}さんの役職を奪いますか？ 確定後は変更できません。`:`${name(priv?.selection)}さんで確定しますか？ 確定後は変更できません。`,action:'confirm'});
   else void send('confirm');
 }}>{priv?.confirmed?'確認済み・みんなを待っています':busy?'送信中…':hunterShot?'この人への発砲を確定':vote?'この人への投票を確定':breadChoice?'このパンを焼く':night&&ability?'この対象で確定':thiefChoice?'この人の役職を奪う':phase==='roles'?'役職を確認しました':resultPhase?'結果を確認しました':'夜の確認を完了'}</button>;

 return <div className={`game-screen ${phase==='night'||phase==='firstNight'?'night-screen':''}`}>
   <div className="game-top"><div><div className="section-number">{pub.day}日目 · {alive.length}人生存</div><h1>{phaseNames[phase]}</h1></div>{seconds!==null&&<div className="game-timer" role="timer" aria-label={`残り${seconds}秒`}><strong>{Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</strong><small>{seconds===0?'操作を待っています':'残り時間'}</small></div>}</div>
   {phase!=='finished'&&<aside className={`current-task ${task.waiting?'task-waiting':''}`} aria-live="polite" aria-atomic="true"><span>今やること</span><h2>{task.title}</h2><p>{task.detail}</p></aside>}
   {offline&&<div className="message" role="status">接続を確認しています。操作の結果を確認できるまで、このままお待ちください。</div>}
   {error&&<div className="message error" role="alert">{error}{pending&&<button className="text-button" disabled={busy} onClick={()=>void send(pending.action,{},pending)}>同じ操作を再送する</button>}</div>}
   {phase!=='finished'&&pub.removals.length>0&&<div className="inline-note">途中脱落：{pub.removals.map(r=>`${name(r.playerId)}さん（${r.day}日目）`).join('、')}</div>}
   {!self.alive&&!hunterShot&&phase!=='finished'&&<div className="spectator-note">あなたは脱落しました。発言・投票・能力使用はせず、静かに見守ってください。</div>}
   {phase==='finished'?<GameResult game={pub} room={room}>{host?<button className="primary" disabled={busy} onClick={()=>setDialog({text:'同じメンバー・設定で待機室に戻ります。前の試合の役職や行動は引き継ぎません。',action:'rematch'})}>同じメンバーで再戦</button>:<p className="muted">主催者が再戦を選ぶと、待機室に戻ります。</p>}<div className="result-exit"><button className="secondary-button" disabled={busy} onClick={onHome}>トップへ戻る</button><p>新しい部屋をつくる・別の部屋に参加する</p></div></GameResult>:<>
     {priv&&<section className="panel private-panel"><div className="panel-heading"><h2>あなただけの情報</h2><button className="text-button" aria-expanded={revealed} onClick={openPrivate}>{revealed?'隠す':'タップして表示'}</button></div>{!revealed?<p className="muted">周りに画面を見せないように確認してください。</p>:<div className="secret-content"><span className="role-team">{teamOf(priv.role)==='wolves'?'人狼側':'村側'}</span><h2 className="your-role">{roleNames[priv.role]}</h2><RoleImage role={priv.role} /><p>{roleDetails[priv.role]}</p>
       {priv.loverId&&<div className="secret-box"><strong>あなたの恋人</strong><p>{name(priv.loverId)}さん</p></div>}
       {priv.thiefExchange?.targetId&&<div className="secret-box thief-result"><strong>怪盗の交換結果</strong><p><b>{name(priv.thiefExchange.targetId)}さん</b>の「{roleNames[priv.thiefExchange.stolenRole]}」を奪いました。</p><p>あなたの現在の役職は<strong>{roleNames[priv.thiefExchange.stolenRole]}</strong>です。</p></div>}
       {game.wolves&&<div className="secret-box"><strong>人狼の仲間</strong><p>{game.wolves.memberIds.filter(id=>id!==me).map(name).join('、')||'あなた1人です。'}</p><small>仲間が誰を希望したかは表示されません。</small></div>}
       {priv.results.length>0&&<div className="secret-box"><strong>能力の結果</strong>{priv.results.map((r,i)=><p key={i}>{r.kind==='initial'?'初夜':`${r.day}日目 ${r.kind==='medium'?'霊媒':'占い'}`} · {name(r.targetId)}さんは<strong>{r.isWolf?'人狼です':'人狼ではありません'}</strong></p>)}</div>}
       {night&&canSelect&&ability&&<><p className="night-task">{priv.selection?'対象を選択しました。下の「この対象で確定」を押してください。':'対象を選んだあと、確定してください。'}</p><h3>{role==='wolf'?'襲撃する人':role==='seer'?'占う人':'護衛する人'}を選ぶ</h3>{role==='knight'&&pub.consecutiveGuard===false&&<p className="inline-note">連続護衛なしの設定です。前の夜に護衛した人は選べません。</p>}{role==='wolf'&&<div className="strength-picker" role="group" aria-label="襲撃の希望度">{([1,2,3] as const).map(value=><button type="button" className={wolfStrength===value?'selected':''} aria-pressed={wolfStrength===value} key={value} onClick={()=>{setWolfStrength(value);if(priv.selection)void send('select',{targetId:priv.selection,strength:value});}}>{value===1?'弱く希望':value===2?'希望':'強く希望'}（{value}）</button>)}</div>}{selector}</>}
       {breadChoice&&canSelect&&<><p className="night-task">{priv.selection?'パンを選びました。確定すると今夜のパンになります。':'今夜焼くパンを選んでください。'}</p><h3>届けるパンを選ぶ</h3>{breadSelector}</>}
       {(night||breadChoice)&&confirmButton}
       <small>20秒後、または画面を離れたときに自動で隠れます。</small>
     </div>}</section>}
     <section className="panel phase-panel">{pub.compositionMode==='random'&&<p className="inline-note">ランダム配役 · 開始時の人狼{pub.fixedWolves}人 · 候補：{pub.randomCandidates?.map(role=>roleNames[role]).join('、')||'なし'}。配役人数は終了まで秘密です。</p>}
       {phase==='hunter'&&<><p>{pub.voteResult&&pub.voteResult.executedId===pub.hunter?.actorId?`${name(pub.hunter?.actorId)}さんが${pub.voteResult.counts[pub.hunter!.actorId]??0}票で処刑されました。`:`${name(pub.hunter?.actorId)}さんが人狼の襲撃で脱落しました。`}</p><h2>{name(pub.hunter?.actorId)}さんは狩人でした</h2><p>狩人だったため、最後の発砲を行います。発砲と恋人の後追いを処理してから勝敗を判定します。</p>{hunterShot?<><p>あなたが最後に撃つ生存者1人を選んでください。騎士の護衛では防げません。</p>{canSelect&&selector}{confirmButton}</>:<p>狩人本人の選択を待っています。</p>}</>}
       {phase==='roles'&&<><h2>役職を確認しましょう</h2><p>上の「タップして表示」で自分の役職を確認してから、確認完了を押してください。</p>{thiefChoice&&canSelect&&<><h3>役職を奪う人を選ぶ</h3><p>確定すると変更できません。交換はほかの人には知らされません。</p>{selector}</>}{self.alive&&confirmButton}</>}
       {phase==='firstNight'&&<><h2>最初の夜です</h2><p>今夜は襲撃・護衛・占いはありません。パン屋は最初に届けるパンを選び、怪盗は交換後の役職を「あなただけの情報」で確認できます。</p>{self.alive&&!breadChoice&&confirmButton}</>}
       {phase==='discussion'&&<><h2>顔を上げて、話し合おう。</h2>{pub.day===1&&pub.breadDelivery?.day===0&&<div className="bread-notice delivered" role="status"><span aria-hidden="true">🥖</span><div><strong>{breadNames[pub.breadDelivery.breadType]}が届きました</strong><p>パン屋が最初の夜に焼いたパンです。パン屋の名前は公開されません。</p></div></div>}<p>誰が人狼なのか、気になった発言や考えを共有しましょう。時間になると投票へ進みます。</p></>}
       {vote&&<><h2>{phase==='runoff'?'同票の候補者から選んでください':'投票する人を選んでください'}</h2><p>{canVoteNoExecution?'自分以外の生存者、または「誰も処刑しない」に投票します。':'自分以外の生存者に投票します。'}確定後は変更できません。</p>{canSelect&&selector}{self.alive&&confirmButton}</>}
       {night&&<><h2>静かに、夜の行動を。</h2><p>生存者全員が「あなただけの情報」を開き、操作を完了してください。能力がない人も確認が必要です。全員が完了すると、残り時間に関係なく朝へ進みます。</p>{priv?.confirmed&&<p className="complete-note">操作は完了しています。みんなを待ちましょう。</p>}</>}
       {phase==='execution'&&<><h2>{pub.voteResult?.executedId?`${name(pub.voteResult.executedId)}さんが処刑されました`:noExecutionWon?'投票の結果、誰も処刑されませんでした':'同票のため、処刑はありません'}</h2><p>{pub.voteResult?.executedId?'処刑や狩人の発砲の経緯は、下の公開ログで確認できます。':'今夜へ進みます。'}</p></>}
       {phase==='morning'&&<><h2>朝になりました</h2>{((pub.composition?.baker??0)>0 || pub.compositionMode==='random' && pub.randomCandidates?.includes('baker'))&&<div className={`bread-notice ${pub.breadDelivered?'delivered':'missing'}`} role="status"><span aria-hidden="true">{pub.breadDelivered?'🥖':'…'}</span><div><strong>{pub.breadDelivered&&pub.breadDelivery?`${breadNames[pub.breadDelivery.breadType]}が届きました`:'今日はパンが届きませんでした'}</strong><p>{pub.compositionMode==='random'?(pub.breadDelivered?'パン屋の名前は公開されません。':'パンが届かなかった理由は公開されません。'):pub.breadDelivered?'パン屋は昨夜を生き延びました。誰なのかは公開されません。':'パン屋はすでに脱落しているか、昨夜の処理で脱落しました。'}</p></div></div>}<div className={`attack-result-notice ${pub.victimId?'has-victim':'no-victim'}`} role="status"><span>昨夜の襲撃結果</span>{pub.victimId?<><strong>{name(pub.victimId)}さんが犠牲になりました</strong><p>{name(pub.victimId)}さんは、人狼の襲撃によって脱落しました。</p></>:<><strong>昨夜の犠牲者はいませんでした</strong><p>犠牲者が出なかった理由は公開されません。</p></>}</div><p>結果を確認したら、次の議論に進みましょう。</p></>}
       {resultPhase&&pub.followedIds?.length>0&&<div className="lover-follow-notice" role="status"><strong>恋人の後追いが発生しました</strong>{pub.followedIds.map(id=><p key={id}>{name(id)}さんは、{name(directlyEliminatedId)}さんの<strong>恋人だったため</strong>、後追いで脱落しました。</p>)}</div>}
       {resultPhase&&pub.resultConfirmation&&<div className="result-confirm"><p>生存者全員の確認で、自動的に次へ進みます。</p>{self.alive&&confirmButton}</div>}
       {(['roles','firstNight','vote','runoff','night'].includes(phase)||(resultPhase&&pub.resultConfirmation))&&<div className="completion"><span>操作完了</span><strong>{pub.completedCount} / {pub.requiredCount}人</strong><progress value={pub.completedCount} max={pub.requiredCount}/></div>}
       {seconds===0&&['vote','runoff','night'].includes(phase)&&<p className="inline-note">時間は終了しましたが、操作は引き続き受け付けています。自動で投票や能力使用はしません。</p>}
       {pub.voteResult&&['runoff','execution'].includes(phase)&&<div className="vote-counts"><h3>得票数</h3>{Object.entries(pub.voteResult.counts).map(([id,n])=><div key={id}><span>{name(id)}</span><b>{n}票</b></div>)}</div>}
     </section>
     <PublicLog events={pub.publicLog??[]} room={room}/>
     <section className="panel"><div className="panel-heading"><h2>参加者</h2><span>{alive.length}人生存</span></div><div className="game-players">{pub.players.map(p=><div className={p.alive?'':'eliminated'} key={p.id}><span>{name(p.id)}{p.id===me?'（あなた）':''}</span><small>{p.alive?'生存':'脱落'}</small></div>)}</div></section>
     {host&&<section className="panel host-controls"><h2>主催者の操作</h2><div className="host-actions">
       {['discussion','vote','runoff','night','hunter'].includes(phase)&&<button className="secondary-button" disabled={busy} onClick={()=>void send('extend')}>60秒延長する</button>}
       {phase==='hunter'&&seconds===0&&<button className="secondary-button" disabled={busy} onClick={()=>setDialog({text:'狩人の発砲を中止しますか？ 発砲せずに勝敗判定と次の段階へ進みます。',action:'cancelShot'})}>発砲を中止する</button>}
       {resultPhase&&!pub.resultConfirmation&&<button className="primary" disabled={busy} onClick={()=>void send('next')}>次へ進む</button>}
       {phase==='discussion'&&<button className="secondary-button" disabled={busy} onClick={()=>setDialog({text:'議論を終了して、投票に進みますか？',action:'startVote'})}>投票へ進む</button>}
     </div><details><summary>復帰できない参加者がいるとき</summary><p>対象者を脱落扱いにします。投票・夜の操作中は全員の操作を取り消し、その段階をやり直します。</p>{alive.map(p=><button className="remove-player" disabled={busy} key={p.id} onClick={()=>setDialog({text:`${name(p.id)}さんを脱落扱いにしますか？ この試合には復帰できません。`,action:'remove',targetId:p.id})}>{name(p.id)}さんを脱落扱いにする</button>)}</details></section>}
   </>}
   {dialog&&<Confirmation onClose={()=>setDialog(null)}><h2 id="confirm-title">確認してください</h2><p>{dialog.text}</p><button className="primary" autoFocus disabled={busy} onClick={()=>void send(dialog.action,dialog.targetId?{targetId:dialog.targetId}:{})}>確定する</button><button className="secondary-button" onClick={()=>setDialog(null)}>戻る</button></Confirmation>}
 </div>;
}

function Confirmation({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
 const ref = useRef<HTMLDialogElement>(null);
 useEffect(() => { const node=ref.current; node?.showModal(); return () => node?.close(); }, []);
 return <dialog className="confirm-dialog" ref={ref} aria-labelledby="confirm-title" onCancel={onClose}>{children}</dialog>;
}
