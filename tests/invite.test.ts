import test from 'node:test';
import assert from 'node:assert/strict';
import { invitationUrl, requestId } from '../src/web/invite.ts';

test('パソコン専用のURLから開いてもQRには設定したLANアドレスを使う', () => {
  assert.equal(invitationUrl('http://127.0.0.1:5173', '/', 'ABCDEF1234', false, 'http://192.168.1.10:5173'), 'http://192.168.1.10:5173/?room=ABCDEF1234');
});
test('公開環境では現在のURL、プレビューは参加用コードを含めない', () => {
  assert.equal(invitationUrl('https://example.com', '/game/', 'ABCDEF1234', false), 'https://example.com/game/?room=ABCDEF1234');
  assert.equal(invitationUrl('https://example.com', '/', 'ABCDEF1234', true), 'https://example.com/?preview=1');
  assert.throws(() => invitationUrl('https://example.com', '/', 'CODE', false, 'file:///tmp/'));
});
test('ローカルWi-Fiでも操作IDに使えるUUIDを生成する', () => {
  assert.match(requestId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
