import test from 'node:test';
import assert from 'node:assert/strict';
import { currentTask } from '../src/web/current-task.ts';
const base={phase:'vote' as const,alive:true,confirmed:false,selected:false,roleSeen:false,busy:false,retryPending:false,offline:false};
test('投票の未選択・選択済み・確定済みを区別する',()=>{
 assert.match(currentTask(base).title,/相手を選/);
 assert.match(currentTask({...base,selected:true}).title,/確定/);
 assert.equal(currentTask({...base,selected:true,confirmed:true}).waiting,true);
});
test('夜の隠れた能力選択の状態で上部の案内を変えない',()=>{
 assert.deepEqual(currentTask({...base,phase:'night',selected:false}),currentTask({...base,phase:'night',selected:true}));
});
test('公開結果は主催者の次へ操作を案内し、送信失敗では完了と案内しない',()=>{
 assert.match(currentTask({...base,phase:'execution',alive:false,resultConfirmation:false}).detail,/主催者/);
 assert.match(currentTask({...base,phase:'morning',resultConfirmation:false}).detail,/主催者/);
 assert.match(currentTask({...base,confirmed:true,retryPending:true}).title,/送信結果/);
});
