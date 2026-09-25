# Supabaseの接続準備

この段階で作成済みなのは、トップ・部屋作成・コード参加・待機室の画面と、部屋の保存処理です。ゲーム開始以降の通信接続は次の開発段階です。

## 1. プロジェクトを作成

[Supabase Dashboard](https://supabase.com/dashboard)で、このゲーム専用の新しいプロジェクトを作成します。名前の例は `face-to-face-werewolf`。プランと料金は作成画面で確認してください。データベースのパスワードは自分で保存します。このアプリの設定やチャットには入力しません。

次の接続作業で必要なのは以下の2つです。

- Project URL（`https://...supabase.co`）
- Publishable key（`sb_publishable_...`、ブラウザ用の公開キー）

`sb_secret_...`、`service_role`、データベースのパスワードはブラウザに渡しません。

## 2. 匿名参加を有効にする

Authenticationの設定でAnonymous Sign-Insを有効にします。参加者はメール登録不要で、同じブラウザに保存した認証情報で復帰します。

外部へ公開する前には、Supabase AuthのCAPTCHA保護も設定します。この画面はCloudflare Turnstileに対応しています。Supabase側にTurnstileのSecret key、アプリ側にSite keyを設定します。未設定でAuth側だけCAPTCHAを有効にすると新規参加できません。

参考: [匿名認証](https://supabase.com/docs/guides/auth/auth-anonymous)、[CAPTCHA保護](https://supabase.com/docs/guides/auth/auth-captcha)、[Turnstileの表示](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)。

## 3. 保存処理を作成

新しいプロジェクトのSQL Editorで、以下を順番に実行します（既存プロジェクトに繰り返し実行しないこと）。CLIを導入済みなら同じファイルを通常のマイグレーションとして適用できます。

1. `supabase/migrations/202609250001_lobby.sql`
2. `supabase/migrations/202609250002_realtime.sql`

1つ目は部屋・参加者・権限制限・操作窓口、2つ目は変更通知です。`app_private`スキーマはData APIの公開スキーマに追加しません。ブラウザが直接読み取れるテーブルは参加部屋の更新番号だけです。部屋本体の取得と変更は`lobby_command`を経由します。

部屋コードは40ビットの無作為な値。作成は認証IDごとに1時間3件、参加試行は10分20件までです。失敗した部屋コードも回数に含めます。認証IDごとの制限に加え、Supabase AuthのIP制限とCAPTCHAを使います。

参考: [データベース関数](https://supabase.com/docs/guides/database/functions)、[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[Realtime](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes)。

## 4. 24時間後の削除を予約

Supabase Cron（pg_cron）を有効にした後、SQL Editorで以下を実行します。対象はこのアプリの部屋と参加試行のみです。

```sql
select cron.schedule(
  'werewolf-lobby-cleanup',
  '* * * * *',
  'select app_private.cleanup_lobbies();'
);
```

最終操作から24時間で部屋へのアクセスを禁止し、1分ごとの清掃で物理削除します。単なる接続維持・再読み込みでは有効期限を延ばしません。Cron登録前は物理削除が自動実行されません。匿名認証ユーザー自体の削除はこの処理には含めません。

参考: [Supabase Cron](https://supabase.com/docs/guides/cron/quickstart)。

## 5. 画面に接続する

プロジェクト直下で`.env.example`を`.env.local`へコピーし、URLと公開キーを設定します。`.env.local`はGitHubへ保存しません。

```dotenv
VITE_SUPABASE_URL=https://実際のプロジェクト.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_実際の公開キー
VITE_TURNSTILE_SITE_KEY=
```

`npm run dev`で起動します。設定を変えたら起動し直してください。接続設定なしの場合は「画面確認版」となり、実際の部屋作成は無効です。「待機室をプレビュー」では架空の5人を表示し、保存や参加は行いません。

## 6. 本番接続後に確認すること

以下はまだSupabase実環境では未検証です。

- 別々のブラウザで作成・参加し、参加者一覧が更新されること。
- 招待URL・QR・コードが同じ部屋を指すこと。
- 再読み込みで元の席へ戻れること。
- 主催者の設定が全員へ反映され、他の人は変更できないこと。
- 主催者を60秒以上切断し、接続中の入室順で主催者が移ること。
- 通知を受け損ねても15秒ごとの再取得・復帰時の再取得で追いつくこと。
- 非参加者が部屋の情報や変更通知を取得できないこと。
- Cronの実行履歴で古い部屋が削除されること。
- Safari・Chromeの実機で表示・QR・再接続を確認すること。

ローカルの自動テストはPostgreSQL互換実行環境PGliteでSQLを実行し、認証IDを模擬して権限・人数・復帰・期限を確認します。Supabase Authサービス、Realtime配信、複数接続の競合、実機表示の検証を置き換えるものではありません。
