import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import QRCode from 'qrcode';
import { DEFAULT_COMPOSITIONS, validateComposition } from '../domain/rules.ts';
import type { Composition, Role } from '../domain/rules.ts';
import { captchaSiteKey, configured, ensureSession, hasSession, lobby, watchRoom, membership, resetPoints, RoomAccessLostError } from './api.ts';
import type { Room } from './types.ts';
import { roleNames } from './types.ts';
import GameScreen from './GameScreen.tsx';
import { gameCommand, GameError } from './game-api.ts';
import { DEFAULT_VICTORY_POINTS, validateVictoryPoints } from '../domain/scoring.ts';
import type { VictoryPoints } from '../domain/scoring.ts';
import { Scoreboard, ScoringRules } from './Points.tsx';
import Turnstile from './Turnstile.tsx';
import { invitationUrl, requestId as newRequestId } from './invite.ts';

const LAST_ROOM = 'werewolf.last-room';
const REQUEST = 'werewolf.create-request';
const names = ['あなた', 'あおい', 'はる', 'みなと', 'ひなた'];
const demoRoom = (): Room => ({ id: 'preview', code: 'A7C92F4B10', hostId: 'p0', viewerId: 'p0', status: 'waiting', revision: 1,
  loverRole: true, victoryPoints: { ...DEFAULT_VICTORY_POINTS }, discussionMinutes: 3, composition: { ...DEFAULT_COMPOSITIONS[5]! }, customComposition: false,
  members: names.map((nickname, i) => ({ id: `p${i}`, nickname, connected: true })) });
function readSaved(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key: string, value: string | null) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* The auth layer reports storage failures. */ } }
function inviteCode() { return new URLSearchParams(location.search).get('room')?.replace(/[\s-]/g, '').toUpperCase() ?? ''; }
function Moon({ small = false }: { small?: boolean }) {
  return <svg width={small ? 24 : 48} height={small ? 24 : 48} viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M35 31A17 17 0 0 1 17 8a18 18 0 1 0 18 23Z" fill="currentColor"/><path d="m34 7 1.6 4.4L40 13l-4.4 1.6L34 19l-1.6-4.4L28 13l4.4-1.6Z" fill="currentColor"/></svg>;
}
function Forest() {
  return <svg className="forest" viewBox="0 0 600 320" fill="none" aria-hidden="true">
    <circle cx="437" cy="68" r="39" fill="#e4c790"/><circle cx="455" cy="52" r="37" fill="#203b33"/>
    <path d="M0 245Q130 158 290 237T600 203V320H0Z" fill="#365347"/><path d="M0 288Q170 211 333 284T600 234V320H0Z" fill="#294438"/>
    {[60, 126, 502, 552].map((x, i) => <g key={x} fill={i % 2 ? '#142b24' : '#1b332a'}><path d={`M${x} ${88 + i * 13} l-38 118 h23 l-36 54 h41 v60 h19 v-60 h36 l-36-54 h24Z`}/></g>)}
    <path d="m286 275 12-46-9-31 23 14 28-11 15-30 9 37-12 29-10 38 16 28h-18l-16-29-13 9-4 20h-20l8-27Z" fill="#e5dfcd"/><path d="m286 269-29-15-17 9 24 26 28-2" fill="#e5dfcd"/><circle cx="345" cy="217" r="2.4" fill="#203b33"/>
    <g fill="#dfc995"><circle cx="207" cy="53" r="2"/><circle cx="322" cy="84" r="2"/><circle cx="145" cy="35" r="1.5"/><circle cx="517" cy="43" r="1.5"/><path d="m269 111 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z"/></g>
  </svg>;
}

export default function App() {
  const [screen, setScreen] = useState<'home' | 'create' | 'join'>(inviteCode() ? 'join' : 'home');
  const [room, setRoom] = useState<Room | null>(null);
  const [preview, setPreview] = useState(false);
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState(inviteCode());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [sessionExists, setSessionExists] = useState(false);
  const [token, setToken] = useState('');
  const [captchaVersion, setCaptchaVersion] = useState(0);
  const [savedRoom, setSavedRoom] = useState(readSaved(LAST_ROOM));
  const operation = useRef(false);
  const startRequest = useRef<{ revision: number; requestId: string } | null>(null);
  const receiveRoom = useCallback((next: Room) => {
    setRoom(current => current?.id === next.id && next.revision >= current.revision ? next : current);
  }, []);
  const clearSavedRoom = useCallback((id?: string) => {
    if (!id || readSaved(LAST_ROOM) === id) { save(LAST_ROOM, null); setSavedRoom(null); }
    startRequest.current = null;
  }, []);
  const needsCaptcha = configured && Boolean(captchaSiteKey) && !sessionExists;

  useEffect(() => { void hasSession().then(setSessionExists).catch(() => {}); }, []);
  useEffect(() => {
    if (new URLSearchParams(location.search).has('preview')) { setPreview(true); setRoom(demoRoom()); }
  }, []);

  const resume = useCallback(async (id: string, automatic = false) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError('');
    try {
      if (!await hasSession()) throw new Error('このブラウザの参加情報が見つかりません。招待コードから参加してください。');
      const restored = await lobby('heartbeat', { roomId: id });
      setPreview(false);
      if (automatic && restored.status === 'finished') {
        setRoom(null); setScreen('home'); setNotice('前の試合は終了しています。新しい部屋をつくるか、招待された部屋に参加してください。');
      } else { setRoom(restored); setNotice(''); }
    } catch (e) { if (e instanceof RoomAccessLostError) clearSavedRoom(id); setError((e as Error).message); }
    finally { setBusy(false); operation.current = false; }
  }, [clearSavedRoom]);
  useEffect(() => {
    if (configured && savedRoom && !inviteCode() && !new URLSearchParams(location.search).has('preview')) void resume(savedRoom, true);
    // The mount restore must not run again after a user chooses another screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume]);

  useEffect(() => {
    if (!room || preview) return;
    const id = room.id; let disposed = false; let loading = false;
    const refresh = async () => {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true;
      try {
        const next = await lobby('heartbeat', { roomId: id });
        if (!disposed) {
          setRoom(current => current?.id === id && next.revision >= current.revision ? next : current);
          setSyncing(false);
        }
      } catch (e) {
        if (!disposed && e instanceof RoomAccessLostError) {
          clearSavedRoom(id); setRoom(null); setScreen('home'); setSyncing(false); setNotice(e.message); setError('');
        } else if (!disposed) setSyncing(true);
      }
      finally { loading = false; }
    };
    const stop = watchRoom(id, () => { void refresh(); });
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    const visible = () => { void refresh(); };
    window.addEventListener('online', visible); document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => { disposed = true; stop(); clearInterval(timer); window.removeEventListener('online', visible); document.removeEventListener('visibilitychange', visible); };
  }, [room?.id, preview, clearSavedRoom]);

  async function enterRoom(event: FormEvent) {
    event.preventDefault(); if (operation.current) return;
    operation.current = true; setBusy(true); setError('');
    try {
      await ensureSession(token || undefined); setSessionExists(true);
      let requestId = readSaved(REQUEST);
      if (screen === 'create' && !requestId) { requestId = newRequestId(); save(REQUEST, requestId); }
      const next = await lobby(screen === 'create' ? 'create' : 'join', { nickname: nickname.normalize('NFKC').trim(), code, requestId });
      save(LAST_ROOM, next.id); setSavedRoom(next.id); save(REQUEST, null);
      setRoom(next); setPreview(false); setNotice('');
      history.replaceState(null, '', location.pathname);
    } catch (e) { if (screen === 'create' && e instanceof RoomAccessLostError) save(REQUEST, null); setError((e as Error).message); setToken(''); setCaptchaVersion(v => v + 1); }
    finally { setBusy(false); operation.current = false; }
  }
  function home() { setRoom(null); setScreen('home'); setError(''); setNotice(''); setPreview(false); history.replaceState(null, '', location.pathname); }
  async function updateSettings(composition: Composition | null, discussionMinutes: number, victoryPoints?: VictoryPoints) {
    if (!room || operation.current) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (preview) setRoom({ ...room, composition: composition ?? { ...DEFAULT_COMPOSITIONS[room.members.length]! }, customComposition: composition !== null, discussionMinutes, victoryPoints, revision: room.revision + 1 });
      else {
        // Older servers accept six roles; hide the new role until migration 011 is available.
        const compPayload = composition && !room.loverRole ? Object.fromEntries(Object.entries(composition).filter(([role]) => role !== 'lover')) : composition;
        const pointsPayload = victoryPoints && !room.loverRole ? Object.fromEntries(Object.entries(victoryPoints).filter(([role]) => role !== 'lover')) : victoryPoints;
        const updated = await lobby('settings', { roomId: room.id, revision: room.revision, composition: compPayload, discussionMinutes, ...(pointsPayload ? { victoryPoints: pointsPayload } : {}) });
        setRoom(current => current?.id === updated.id && current.revision <= updated.revision ? updated : current);
      }
      setNotice(preview ? 'プレビューの設定を変更しました。' : '設定を保存しました。');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); operation.current = false; }
  }

  async function clearPoints() {
    if (!room || operation.current || !window.confirm('全員の累計ポイントを0にします。よろしいですか？ 配点設定は変わりません。')) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (preview) setRoom({ ...room, revision: room.revision + 1, members: room.members.map(m => ({ ...m, points: 0 })) });
      else receiveRoom(await resetPoints({ roomId: room.id, revision: room.revision }));
      setNotice('全員の累計ポイントを0にしました。');
    } catch (e) {
      setError((e as Error).message);
      try { if (!preview) receiveRoom(await lobby('get', { roomId: room.id })); } catch { /* Next refresh recovers connection. */ }
    } finally { operation.current = false; setBusy(false); }
  }

  async function manageMember(action: 'remove' | 'leave', targetId?: string) {
    if (!room || preview || operation.current) return;
    const target = room.members.find(m => m.id === targetId);
    const text = action === 'remove'
      ? `${target?.nickname ?? 'この参加者'}さんを待機室から削除しますか？ この参加者の累計ポイントも消えます。配役は人数に合わせたおすすめに戻ります。`
      : '部屋から退出しますか？ あなたの累計ポイントも消えます。主催者なら次の参加者へ権限を移し、最後の1人なら部屋を削除します。配役はおすすめに戻ります。';
    if (!window.confirm(text)) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await membership(action, { roomId: room.id, memberId: room.viewerId, revision: room.revision, targetId });
      if (result.left) { clearSavedRoom(room.id); home(); setNotice('部屋から退出しました。'); }
      else if (result.room) { receiveRoom(result.room); setNotice('参加者を削除し、配役をおすすめに戻しました。'); }
    } catch (e) {
      setError((e as Error).message);
      // Recover after an ambiguous response without changing any newer room.
      try { receiveRoom(await lobby('get', { roomId: room.id })); }
      catch (refreshError) { if (refreshError instanceof RoomAccessLostError) { clearSavedRoom(room.id); home(); setNotice(refreshError.message); } }
    } finally { operation.current = false; setBusy(false); }
  }
  function forgetHistory() {
    if (!window.confirm('この端末の「前の部屋に戻る」を消しますか？ 待機室の参加者からも消す場合は、部屋に戻って退出してください。')) return;
    clearSavedRoom(); setNotice('この端末の部屋履歴を消しました。');
  }

  async function startGame() {
    if (!room || preview || operation.current) return;
    if (!startRequest.current && !window.confirm('全員そろいましたか？ 役職を配ってゲームを開始します。')) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    const request = startRequest.current ?? { revision: room.revision, requestId: newRequestId() };
    startRequest.current = request;
    try {
      const result = await gameCommand('start', { roomId: room.id, ...request });
      receiveRoom(result.room); startRequest.current = null;
    } catch (e) {
      setError((e as Error).message);
      if (!(e instanceof GameError && e.retryable)) startRequest.current = null;
    } finally { operation.current = false; setBusy(false); }
  }

  return <div className="app">
    <header className="site-header"><button className="brand" onClick={home} aria-label="夜のよりあい トップへ"><Moon small/><span>夜のよりあい</span></button><span className="header-note">集まって、話して、見抜こう。</span><span className="edition">対面人狼</span></header>
    <main>
      {preview && <div className="preview-banner">画面プレビュー <span>参加者は見本です。実際の部屋は作成されません。</span><button onClick={home}>終了</button></div>}
      {error && <div className="message error" role="alert">{error}</div>}
      {notice && <div className="message" role="status">{notice}</div>}
      {room ? room.status === 'waiting' ? <Lobby room={room} preview={preview} busy={busy} syncing={syncing} onResetPoints={clearPoints} onSave={updateSettings} onNotice={setNotice} onStart={startGame} onMember={manageMember} /> : <GameScreen key={room.id} room={room} onRoom={receiveRoom} onHome={home}/> : <>
        {screen === 'home' ? <div className="home-grid">
          <section className="hero"><div className="eyebrow">A LITTLE MYSTERY, TOGETHER.</div><h1>いつもの顔に、<br/>ひとつの秘密。</h1><p>この中に、人狼がいる。<br/>同じ場所に集まった仲間と、<br/>スマホひとつで始まる推理の夜。</p><div className="hero-tags"><span>5〜13人</span><span>司会者いらず</span><span>登録不要</span></div><Forest/></section>
          <section className="home-actions"><div className="section-number">01 — 集まる</div><h2>さあ、席につこう。</h2><p className="muted">会話は目の前で。進行はおまかせ。</p>
            <button className="action-card" disabled={busy} onClick={() => { setScreen('create'); setError(''); }}><span className="action-icon">＋</span><span><strong>部屋をつくる</strong><small>主催者になって、みんなを招待</small></span><span className="arrow">↗</span></button>
            <button className="action-card secondary-card" disabled={busy} onClick={() => { setScreen('join'); setError(''); }}><span className="action-icon">⌗</span><span><strong>部屋に参加する</strong><small>招待された部屋のコードを入力</small></span><span className="arrow">→</span></button>
            {savedRoom && <div className="saved-room-actions">{configured && <button className="resume" disabled={busy} onClick={() => void resume(savedRoom)}>前の部屋に戻る →</button>}<button className="text-button" disabled={busy} onClick={forgetHistory}>部屋の履歴を消す</button></div>}
            {!configured && <div className="preview-note"><span className="dot"/>現在は画面確認版です。<button className="text-button" onClick={() => { setPreview(true); setRoom(demoRoom()); setError(''); }}>待機室をプレビュー →</button></div>}
            <div className="how"><div><b>1</b><span>仲間を招待</span></div><i/><div><b>2</b><span>役職を確認</span></div><i/><div><b>3</b><span>会話で推理</span></div></div>
          </section>
        </div> : <section className="entry-card">
          <button className="text-button back" onClick={home}>← トップへ</button><div className="section-number">{screen === 'create' ? 'HOST A ROOM' : 'JOIN YOUR FRIENDS'}</div>
          <h1>{screen === 'create' ? '今夜の部屋をつくる。' : 'みんなの待つ部屋へ。'}</h1><p className="muted">{screen === 'create' ? 'あなたもプレイヤーとして参加できます。' : '招待コードと、呼ばれたい名前を入力してください。'}</p>
          <form onSubmit={enterRoom}>
            {screen === 'join' && <label>部屋コード<input value={code} onChange={e => setCode(e.target.value.replace(/[\s-]/g, '').toUpperCase())} placeholder="A7C92F4B10" required minLength={10} maxLength={10} pattern="[A-Fa-f0-9]{10}" autoCapitalize="characters" autoCorrect="off" spellCheck={false}/></label>}
            <label>ニックネーム<input value={nickname} onChange={e => setNickname(e.target.value)} placeholder="例：ゆう" required maxLength={20} autoComplete="nickname"/><small>1〜20文字。同じ部屋では名前を重複できません。</small></label>
            {needsCaptcha && <Turnstile key={captchaVersion} siteKey={captchaSiteKey} onToken={setToken} onError={setError}/>}
            {!configured && <div className="inline-note">ただいま接続の準備中です。待機室のプレビューをお試しいただけます。</div>}
            <button className="primary" disabled={busy || !configured || (needsCaptcha && !token)}>{busy ? '接続しています…' : screen === 'create' ? '部屋をつくる →' : '参加する →'}</button>
          </form>
          {!configured && <button className="text-button" onClick={() => { const demo = demoRoom(); if (nickname.trim()) demo.members[0]!.nickname = nickname.trim(); setRoom(demo); setPreview(true); setError(''); }}>待機室をプレビュー →</button>}
          <p className="small-note">メールアドレスの登録は不要です。<br/>再参加するときは、同じ端末・ブラウザを使ってください。</p>
        </section>}
        <section className="promise"><Moon small/><p>ひみつはスマホに。会話は、この場で。</p><span>インストールも、専任の司会者もいりません。</span></section>
      </>}
    </main>
    <footer><span>夜のよりあい</span><span>友だちと囲む、小さな推理の時間。</span><small>開発中 · {room ? room.status === 'waiting' ? '待機室' : 'ゲーム' : 'はじめの一歩'}</small></footer>
  </div>;
}

function Lobby({ room, preview, busy, syncing, onSave, onNotice, onStart, onMember, onResetPoints }: {
  room: Room; preview: boolean; busy: boolean; syncing: boolean; onStart: () => Promise<void>; onMember: (action: 'remove' | 'leave', targetId?: string) => Promise<void>;
  onResetPoints: () => Promise<void>;
  onSave: (composition: Composition | null, minutes: number, victoryPoints?: VictoryPoints) => Promise<void>; onNotice: (message: string) => void;
}) {
  const [pointsDraft, setPointsDraft] = useState<VictoryPoints>({ ...DEFAULT_VICTORY_POINTS, ...room.victoryPoints });
  const [qr, setQr] = useState('');
  const [editing, setEditing] = useState(false);
  const [minutes, setMinutes] = useState(room.discussionMinutes);
  const [custom, setCustom] = useState(room.customComposition);
  const [draft, setDraft] = useState<Composition>(room.composition ? { ...room.composition, madman: room.composition.madman ?? 0, lover: room.composition.lover ?? 0 } : { ...DEFAULT_COMPOSITIONS[5]! });
  const availableRoles = (Object.keys(roleNames) as Role[]).filter(role => role !== 'lover' || room.loverRole);
  const isHost = room.viewerId === room.hostId;
  const count = room.members.length;
  const invite = invitationUrl(location.origin, location.pathname, room.code, preview, import.meta.env.VITE_INVITE_BASE_URL);
  const host = room.members.find(m => m.id === room.hostId);
  let settingError = '';
  try { if (custom) validateComposition(count, draft); } catch (e) { settingError = (e as Error).message; }
  let pointsError = '';
  try { if (room.victoryPoints) validateVictoryPoints(pointsDraft); } catch (e) { pointsError = (e as Error).message; }
  let currentError = '';
  try { if (room.composition) validateComposition(count, { ...room.composition, madman: room.composition.madman ?? 0, lover: room.composition.lover ?? 0 }); } catch (e) { currentError = (e as Error).message; }
  useEffect(() => { let active = true; void QRCode.toDataURL(invite, { margin: 2, width: 180, color: { dark: '#182d26', light: '#ffffff' } }).then(image => { if (active) setQr(image); }); return () => { active = false; }; }, [invite]);
  useEffect(() => { setPointsDraft({ ...DEFAULT_VICTORY_POINTS, ...room.victoryPoints }); setEditing(false); setMinutes(room.discussionMinutes); setCustom(room.customComposition); setDraft(room.composition ? { ...room.composition, madman: room.composition.madman ?? 0, lover: room.composition.lover ?? 0 } : { ...DEFAULT_COMPOSITIONS[5]! }); }, [room.revision, room.hostId]);
  async function copy() {
    try { await navigator.clipboard.writeText(invite); onNotice(preview ? 'プレビュー用のリンクをコピーしました。' : '招待リンクをコピーしました。'); }
    catch { onNotice('リンクを長押ししてコピーしてください。'); }
  }
  return <div className="lobby">
    <div className="lobby-title"><div><div className="section-number">THE GATHERING</div><h1>今夜の待ち合わせ。</h1><p className="muted">みんなが集まるまで、ひと息。</p></div><span className={`status-pill ${syncing ? 'offline' : ''}`}><span className="dot"/>{preview ? 'プレビュー' : syncing ? '再接続を待っています' : '参加を受付中'}</span></div>
    <div className="lobby-grid"><div className="lobby-main">
      <section className="panel"><div className="panel-heading"><h2>集まった仲間</h2><span><b>{count}</b> / 13人</span></div><div className="members">
        {room.members.map((member, i) => <div className="member" key={member.id}><div className={`avatar tone-${i % 4}`}>{member.nickname.slice(0, 1)}</div><div><strong>{member.nickname}</strong><small>{member.id === room.hostId ? '主催者' : `プレイヤー ${i + 1}`}{member.id === room.viewerId ? ' · あなた' : ''}</small></div><span className={`connection ${member.connected ? '' : 'away'}`}>{member.connected ? '●' : '○'}<span className="sr-only">{member.connected ? '接続中' : '接続を待っています'}</span></span>{isHost && !preview && member.id !== room.viewerId && <button className="member-remove" disabled={busy} aria-label={`${member.nickname}さんを待機室から削除`} onClick={() => void onMember('remove', member.id)}>削除</button>}</div>)}
        {count < 5 && <div className="empty-seat"><span>＋</span>あと{5 - count}人で、始められる人数になります。</div>}
      </div></section>
      <section className="panel settings"><div className="panel-heading"><h2>今夜のルール</h2>{isHost && <button className="text-button" onClick={() => setEditing(!editing)}>{editing ? '閉じる' : '設定を変更'}</button>}</div>
        <div className="setting-line"><span>昼の議論</span><strong>{room.discussionMinutes}<small> 分</small></strong></div>
        <div className="role-grid">{availableRoles.map((role, index) => <div key={role} className={role === 'wolf' || role === 'madman' ? 'wolf-role' : ''}><span className="role-symbol">{['◇', '◈', '✧', '☽', '♜', '✦', '♡'][index]}</span><span>{roleNames[role]}</span><b>{room.composition ? room.composition[role] ?? 0 : '—'}</b></div>)}</div>
        {room.loverRole && (room.composition?.lover ?? 0) > 0 && <p className="inline-note">恋人は村側の2人組です。片方が脱落すると、もう片方も後追いで脱落します。</p>}
        {!room.composition && <p className="small-note">5人集まると、おすすめの配役が表示されます。</p>}
        {room.customComposition && <p className="inline-note">カスタム配役です。おすすめと異なる配役のバランスは保証されません。</p>}
        {currentError && <p role="alert" className="field-error">参加人数が変わりました。配役を設定し直してください。</p>}
        {editing && isHost && <form className="settings-form" onSubmit={e => { e.preventDefault(); void onSave(custom ? draft : null, minutes, room.victoryPoints ? pointsDraft : undefined); }}>
          <label>議論時間<select value={minutes} onChange={e => setMinutes(Number(e.target.value))}>{Array.from({ length: 10 }, (_, i) => <option value={i + 1} key={i}>{i + 1}分</option>)}</select></label>
          <label className="check-label"><input type="checkbox" checked={custom} onChange={e => setCustom(e.target.checked)}/>配役を自分で決める</label>
          {custom && <div className="role-inputs">{availableRoles.map(role => <label key={role}>{roleNames[role]}{role === 'lover' ? <select aria-label="恋人の人数" value={draft.lover} onChange={e => setDraft({ ...draft, lover: Number(e.target.value) })}><option value={0}>0人</option><option value={2}>2人</option></select> : <input aria-label={`${roleNames[role]}の人数`} type="number" min={0} max={role === 'villager' || role === 'wolf' ? 13 : 1} step={1} value={draft[role]} onChange={e => setDraft({ ...draft, [role]: e.target.valueAsNumber })}/>}</label>)}</div>}
          {room.victoryPoints && <fieldset className="points-inputs"><legend>役職別の勝利点</legend><p className="small-note">0〜10点。変更は次の試合から適用されます。</p><div className="role-inputs">{availableRoles.map(role => <label key={role}>{roleNames[role]}<input aria-label={`${roleNames[role]}の勝利点`} type="number" min={0} max={10} step={1} required value={Number.isNaN(pointsDraft[role]) ? '' : pointsDraft[role]} onChange={e => setPointsDraft({ ...pointsDraft, [role]: e.target.valueAsNumber })}/></label>)}</div></fieldset>}
          {pointsError && <p className="field-error" role="alert">{pointsError}</p>}
          {settingError && <p className="field-error" role="alert">{settingError}</p>}
          <button className="primary" disabled={busy || Boolean(settingError) || Boolean(pointsError)}>設定を保存</button>
        </form>}
        <div className="rule-footnote">初夜の襲撃なし <span>·</span> 役職は本人だけに表示</div>
      </section>
      {room.victoryPoints && <section className="panel points-panel"><Scoreboard room={room}/><ScoringRules points={room.victoryPoints}/>{isHost && <button className="text-button reset-points" disabled={busy} onClick={() => void onResetPoints()}>全員の累計をリセット</button>}</section>}
    </div><aside className="invite-panel"><div className="section-number">INVITE YOUR FRIENDS</div><h2>この輪に、招待しよう。</h2><p>近くの仲間にQRコードを見せるか、<br/>部屋コードを伝えてください。</p>
      <div className="qr-wrap">{qr && <img src={qr} alt={preview ? 'プレビュー用QRコード（実際の招待ではありません）' : '部屋の招待QRコード'} width={180} height={180}/>}</div>
      <span className="code-label">{preview ? '部屋コードの見本' : '部屋コード'}</span><div className="room-code">{room.code.slice(0, 5)}<span> </span>{room.code.slice(5)}</div>
      {!preview && new URL(invite).protocol === 'http:' && <p className="inline-note">接続テスト中です。スマホをこのパソコンと同じWi-Fiにつないでから読み取ってください。</p>}
      <button className="copy-button" onClick={() => void copy()}>{preview ? 'プレビューリンクをコピー' : '招待リンクをコピー'} <span>↗</span></button><input className="invite-url" aria-label={preview ? 'プレビューリンク' : '招待リンク'} value={invite} readOnly onFocus={e => e.currentTarget.select()}/>
      <div className="start-area"><p>{isHost ? 'あなたが今夜の主催者です。' : `主催者は ${host?.nickname ?? '確認中'} さんです。`}</p><button className="primary" disabled={preview || busy || !isHost || count < 5 || !room.composition || Boolean(currentError)} onClick={() => void onStart()}>{busy ? '準備しています…' : isHost ? 'ゲームを開始する' : '主催者の開始を待っています'}</button><small>{preview ? 'プレビューではゲームを開始できません。' : '全員そろったら開始しましょう。開始後の新規参加はできません。'}</small></div>
    </aside></div>
    {!preview && <div className="leave-area"><button className="secondary-button" disabled={busy} onClick={() => void onMember('leave')}>部屋から退出する</button><p>退出すると参加者一覧から名前が消えます。招待コードで再参加できます。</p></div>}
    <div className="lobby-bottom"><span>◌</span><p>画面を閉じても、同じブラウザから席に戻れます。<br/><small>接続が切れても、すぐに脱落することはありません。</small></p></div>
  </div>;
}
