# 対面で遊ぶWeb人狼

同じ場所に集まる5〜10人向けの招待制人狼ゲーム。会話は対面、役職配布・時間管理・投票・夜の処理・勝敗判定はサーバーが担当します。

## 現在の状態

仕様書、ゲームルール、進行処理に加え、Reactのトップ・部屋作成・コード参加・待機室を作成しました。Supabase用の保存処理と接続コードもありますが、実際のプロジェクトは未作成・未接続です。ゲーム開始以降の画面・通信接続と公開環境はまだありません。

- [確定仕様](docs/spec.md)
- [開発手順](docs/roadmap.md)
- `src/domain/rules.ts`: 配役、勝敗、投票、初夜、夜の処理
- `tests/rules.test.ts`: ルールの自動検証
- `src/domain/game.ts`: 進行・時間管理・操作確定・途中脱落・閲覧情報の分離
- `tests/game.test.ts`: 進行と異常系の自動検証
- [サーバー接続時の契約](docs/engine.md)
- `src/web/`: スマホ向け画面、匿名認証、QR招待、待機室の更新・復帰
- `supabase/migrations/`: 部屋・参加者・設定・閲覧制限・主催者移行
- `tests/lobby.test.ts`: PGliteでのSQLと権限の検証
- [Supabaseの設定手順](docs/supabase-setup.md)

## 画面の起動

Node.js 24で`npm ci`、続いて`npm run dev`を実行します。接続先がなくてもトップと待機室のプレビューを確認できます。プレビューの参加者・部屋コードは見本です。実際の招待にはSupabaseの設定が必要です。

`npm run build`で型検査と公開用ファイルの作成、`npm run preview`で作成したファイルの表示を確認できます。

### 同じWi-Fiのスマホで試す

`npm run dev -- --host 0.0.0.0`で起動し、表示されたNetworkのURLを`.env.local`の`VITE_INVITE_BASE_URL`に設定して再起動します。パソコンでlocalhostを開いていても、QRと招待リンクはそのNetworkのURLになります。端末は同じWi-Fiに接続してください。ネットワークが端末間通信を禁止している場合は接続できません。Wi-FiやIPが変わった場合は設定を更新します。

公開時は`VITE_INVITE_BASE_URL`を空にするか、公開先のHTTPS URLに変更してビルドします。

## 検証

`npm run typecheck`で型検査、`npm test`でゲーム処理・部屋のSQL・権限制限を検証します。Supabaseの実環境とスマホの実機での検証は、接続設定後に行います。

## 構成予定

React + TypeScript / Supabase（匿名認証、データベース、リアルタイム配信）。ホスティングの初期候補はCloudflare Pagesです。利用条件・料金は公開前に確認します。

今回の公開にはSitesの静的ホスティングを使用します。`.openai/hosting.json`が公開先を識別します。公開ビルドでは`VITE_INVITE_BASE_URL`を空にして公開ページ自身を招待先にします。ローカルのWi-Fi用URLを公開ファイルへ埋め込まないでください。

ルール処理はサーバー専用です。全員の役職を含む内部状態をブラウザに渡してはいけません。クライアントには権限ごとに絞った情報だけを返します。

GitHubの接続先は https://github.com/Uichi/face-to-face-werewolf です。秘密鍵・認証情報・実際の試合データは保存しません。
