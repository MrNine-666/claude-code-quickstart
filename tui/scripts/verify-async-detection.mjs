import assert from 'node:assert/strict';
import {
	createDetectionRunner,
	createInitialDetectionState,
	reduceDetectionState,
	shouldStartDetection
} from '../dist/services/index.js';

const idle = createInitialDetectionState();
assert.equal(idle.status, 'idle');
assert.equal(shouldStartDetection(idle), true);

const loading = reduceDetectionState(idle, {type: 'start', now: 1});
assert.equal(loading.status, 'loading');
assert.equal(loading.startedAt, 1);
assert.equal(shouldStartDetection(loading), false);
assert.equal(reduceDetectionState(loading, {type: 'start', now: 2}), loading, 'loading 中不得重复触发检测');

const success = reduceDetectionState(loading, {type: 'success', now: 3, result: ['ok']});
assert.equal(success.status, 'success');
assert.deepEqual(success.result, ['ok']);
assert.equal(success.finishedAt, 3);

const failed = reduceDetectionState(loading, {type: 'error', now: 4, error: new Error('boom')});
assert.equal(failed.status, 'error');
assert.equal(failed.error, 'boom');

let ticks = 10;
const states = [];
const runner = createDetectionRunner(createInitialDetectionState(), state => states.push(state), () => ticks++);
const first = runner.run(async () => 'first');
const second = await runner.run(async () => 'second');
assert.equal(second.status, 'loading', '并发中的第二次 run 应复用 loading 状态');
const final = await first;
assert.equal(final.status, 'success');
assert.equal(final.result, 'first');
assert.deepEqual(states.map(state => state.status), ['loading', 'success']);

console.log('[PASS] 并发异步检测状态机门禁通过');
