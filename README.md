# 対面で遊ぶWeb人狼

同じ場所に集まる5〜10人向けの招待制人狼ゲーム。会話は対面、役職配布・時間管理・投票・夜の処理・勝敗判定はサーバーが担当します。

## 現在の状態

仕様書、ゲームルール、役職確認から終了までの進行処理を作成した段階です。画面、部屋への参加、Supabaseとの接続、公開環境はまだありません。

- [確定仕様](docs/spec.md)
- [開発手順](docs/roadmap.md)
- `src/domain/rules.ts`: 配役、勝敗、投票、初夜、夜の処理
- `tests/rules.test.ts`: ルールの自動検証
- `src/domain/game.ts`: 進行・時間管理・操作確定・途中脱落・閲覧情報の分離
- `tests/game.test.ts`: 進行と異常系の自動検証
- [サーバー接続時の契約](docs/engine.md)

## 検証

Node.js 24で `npm ci` を実行し、`npm run typecheck` で型検査、`npm test` で自動テストを行います。実行時の外部パッケージは不要です。

## 構成予定

React + TypeScript / Supabase（匿名認証、データベース、リアルタイム配信）。ホスティングの初期候補はCloudflare Pagesです。利用条件・料金は公開前に確認します。

ルール処理はサーバー専用です。全員の役職を含む内部状態をブラウザに渡してはいけません。クライアントには権限ごとに絞った情報だけを返します。

GitHubの接続先は https://github.com/Uichi/face-to-face-werewolf です。秘密鍵・認証情報・実際の試合データは保存しません。
