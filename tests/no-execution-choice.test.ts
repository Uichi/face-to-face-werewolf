import test from 'node:test';
import assert from 'node:assert/strict';
import { canChooseNoExecution } from '../src/web/no-execution-choice.ts';
import { NO_EXECUTION_ID } from '../src/domain/rules.ts';
test('旧フラグがない最新サーバーでも初日の処刑なしを表示する',()=>{
 for(const capabilities of [{thiefRole:true},{hunterRole:true},{doctorRole:true},{bodybuilderRole:true},{randomComposition:true},{firstDayNoExecution:true}])assert.equal(canChooseNoExecution(capabilities,'vote',1,[]),true);
 assert.equal(canChooseNoExecution({},'vote',1,[]),false);assert.equal(canChooseNoExecution({firstDayNoExecution:false,bodybuilderRole:true},'vote',1,[]),false);
});
test('2日目以降や投票外では表示せず、決選は候補に残ったときだけ表示する',()=>{
 const room={bodybuilderRole:true};
 assert.equal(canChooseNoExecution(room,'vote',2,[]),false);assert.equal(canChooseNoExecution(room,'discussion',1,[]),false);
 assert.equal(canChooseNoExecution(room,'runoff',1,[]),false);assert.equal(canChooseNoExecution(room,'runoff',1,[NO_EXECUTION_ID]),true);
 assert.equal(canChooseNoExecution({},'vote',1,[],true),true);
});
