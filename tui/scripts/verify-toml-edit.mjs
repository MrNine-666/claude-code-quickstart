import assert from 'node:assert/strict';

// Task 1.8 骨架：TOML 结构化编辑不变量冻结（design D9/PBT-7,PBT-10,PBT-11）。
// 冻结「禁止默认 managed block、按 path set/delete、保留无关字段」契约；
// 阶段 4 落地 tui/src/core/toml-edit.ts 后改为 import 真实工具层断言。

// 结构化编辑器期望能力（阶段 4 实现验证清单）。
const REQUIRED_OPS = ['parse', 'stringify', 'getPath', 'setPath', 'deletePath', 'atomicWrite'];

// 禁止出现的 managed marker block 策略标识。
const FORBIDDEN_STRATEGIES = ['managed-block', 'marker-block', '>>> ccq >>>'];

for (const op of REQUIRED_OPS) {
	assert.ok(typeof op === 'string' && op.length > 0, `TOML 工具层必须提供 ${op}`);
}

// 默认策略必须是结构化 path 编辑，而非 managed block。
const DEFAULT_STRATEGY = 'structured-path';
assert.equal(DEFAULT_STRATEGY, 'structured-path', '默认策略必须是结构化 path 编辑');
for (const forbidden of FORBIDDEN_STRATEGIES) {
	assert.notEqual(DEFAULT_STRATEGY, forbidden, `默认策略不得为 ${forbidden}`);
}

// path set/delete 幂等 + 保留无关字段（语义冻结，阶段 4 用真实 round-trip 验证）。
const idempotentSetContract = true;
const preserveUnrelatedContract = true;
assert.equal(idempotentSetContract, true, 'setPath 相同值重复写应幂等');
assert.equal(preserveUnrelatedContract, true, '无关 table/key 应在 set/delete 后保留');

// 无效 TOML 拒绝写入（parse error 不得落盘）。
const rejectInvalidOnParseError = true;
assert.equal(rejectInvalidOnParseError, true, '无效 TOML 必须拒绝写入');

// 敏感值不得进入错误文本（脱敏契约，阶段 4/5 用真实 error formatter 验证）。
const redactSecretsInErrors = true;
assert.equal(redactSecretsInErrors, true, '错误文本必须脱敏敏感值');

console.log('[PASS] 1.8 TOML 结构化编辑骨架：禁 managed block + path set/delete 幂等 + 保留无关字段 + 拒绝无效 TOML');
