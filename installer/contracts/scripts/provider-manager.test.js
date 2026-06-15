#!/usr/bin/env node
/**
 * provider-manager.js 核心不变量单元测试
 *
 * 测试范围：
 * 1. 契约加载 + 一致性断言
 * 2. 工具函数（key 校验、BaseUrl 规范化、身份匹配）
 * 3. 受管 env 层（模型 env / 额外 env 读写、旧版兼容、effective 合并）
 * 4. 数据层（Profile 扫描、活跃身份匹配）
 * 5. 变更层核心逻辑（不实际操作文件系统，使用 mock）
 *
 * 运行：node provider-manager.test.js
 */

'use strict';

const assert = require('assert');
const pm = require('./provider-manager.js');

// ============================================================================
// 测试框架（零依赖迷你版）
// ============================================================================

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failCount++;
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(1, 3).join('\n'));
    }
  }
}

function suite(name, fn) {
  console.log(`\n━━━ ${name} ━━━`);
  fn();
}

// ============================================================================
// 1. 契约层测试
// ============================================================================

suite('契约层', () => {
  test('loadProviderContract 返回有效配置', () => {
    const config = pm.loadProviderContract();
    assert(config, '配置对象不能为空');
    assert(Array.isArray(config.managedModelEnvKeys), 'managedModelEnvKeys 必须是数组');
    assert(config.managedModelEnvKeys.length > 0, 'managedModelEnvKeys 不能为空');
    assert(typeof config.modelEnvLabels === 'object', 'modelEnvLabels 必须是对象');
    assert(Array.isArray(config.managedExtraEnvKeys), 'managedExtraEnvKeys 必须是数组');
    assert(typeof config.builtinProviders === 'object', 'builtinProviders 必须是对象');
    assert(config.builtinProviders.zhipu, '必须包含 zhipu 内置供应商');
  });

  test('内联 fallback 与契约一致性', () => {
    // assertFallbackConsistency 在 loadProviderContract 中已执行
    // 若不一致会直接抛错，测试通过说明一致
    const config = pm.loadProviderContract();
    assert.strictEqual(config.managedModelEnvKeys.length, 3, '受管模型 env 键数量为 3');
    assert(config.managedModelEnvKeys.includes('ANTHROPIC_DEFAULT_HAIKU_MODEL'));
    assert(config.managedModelEnvKeys.includes('ANTHROPIC_DEFAULT_OPUS_MODEL'));
    assert(config.managedModelEnvKeys.includes('ANTHROPIC_DEFAULT_SONNET_MODEL'));
  });

  test('normalizeContract 正确转换 PascalCase → camelCase', () => {
    const raw = {
      ManagedEnv: {
        ProviderManagedModelEnvKeys: ['KEY1', 'KEY2'],
        ProviderModelEnvLabels: { KEY1: 'Label1' },
        ProviderManagedExtraEnvKeys: ['EXTRA1'],
        LegacyProviderModelKey: 'oldKey',
      },
      BuiltinProviders: {
        test: {
          Name: 'Test Provider',
          BaseUrl: 'https://test.example.com',
          ModelEnv: { KEY1: 'model1' },
          ExtraEnv: { EXTRA1: 'value1' },
        },
      },
    };
    const config = pm.normalizeContract(raw);
    assert.deepStrictEqual(config.managedModelEnvKeys, ['KEY1', 'KEY2']);
    assert.strictEqual(config.modelEnvLabels.KEY1, 'Label1');
    assert.deepStrictEqual(config.managedExtraEnvKeys, ['EXTRA1']);
    assert.strictEqual(config.legacyModelKey, 'oldKey');
    assert.strictEqual(config.builtinProviders.test.name, 'Test Provider');
    assert.strictEqual(config.builtinProviders.test.baseUrl, 'https://test.example.com');
    assert.strictEqual(config.builtinProviders.test.modelEnv.KEY1, 'model1');
    assert.strictEqual(config.builtinProviders.test.extraEnv.EXTRA1, 'value1');
  });
});

// ============================================================================
// 2. 工具层测试
// ============================================================================

suite('工具层', () => {
  test('isNullOrWhiteSpace 正确判断', () => {
    assert.strictEqual(pm.isNullOrWhiteSpace(null), true);
    assert.strictEqual(pm.isNullOrWhiteSpace(undefined), true);
    assert.strictEqual(pm.isNullOrWhiteSpace(''), true);
    assert.strictEqual(pm.isNullOrWhiteSpace('   '), true);
    assert.strictEqual(pm.isNullOrWhiteSpace('abc'), false);
    assert.strictEqual(pm.isNullOrWhiteSpace('  abc  '), false);
  });

  test('maskApiKey 脱敏 API Key', () => {
    assert.strictEqual(pm.maskApiKey(''), '-');
    assert.strictEqual(pm.maskApiKey('short'), '***');
    assert.strictEqual(pm.maskApiKey('sk-1234567890abcdef'), 'sk-1...ef');
  });

  test('normalizeBaseUrl 去尾斜杠', () => {
    assert.strictEqual(pm.normalizeBaseUrl('https://example.com/'), 'https://example.com');
    assert.strictEqual(pm.normalizeBaseUrl('https://example.com'), 'https://example.com');
    assert.strictEqual(pm.normalizeBaseUrl('https://example.com///'), 'https://example.com');
    assert.strictEqual(pm.normalizeBaseUrl(''), '');
  });

  test('testProviderBaseUrlMatch 基础匹配', () => {
    assert.strictEqual(
      pm.testProviderBaseUrlMatch('https://api.example.com', 'https://api.example.com'),
      true
    );
    assert.strictEqual(
      pm.testProviderBaseUrlMatch('https://api.example.com/', 'https://api.example.com'),
      true
    );
    assert.strictEqual(
      pm.testProviderBaseUrlMatch('https://api.example.com/v1', 'https://api.example.com'),
      true
    );
    assert.strictEqual(
      pm.testProviderBaseUrlMatch('https://api.example.com', 'https://api.example.com/v1'),
      false
    );
    assert.strictEqual(
      pm.testProviderBaseUrlMatch('https://api.example.com', 'https://other.example.com'),
      false
    );
  });

  test('testProviderAuthTokenMatch Token 完全匹配（大小写敏感）', () => {
    assert.strictEqual(pm.testProviderAuthTokenMatch('sk-abc', 'sk-abc'), true);
    assert.strictEqual(pm.testProviderAuthTokenMatch('sk-abc', 'sk-ABC'), false);
    assert.strictEqual(pm.testProviderAuthTokenMatch('', 'sk-abc'), false);
    assert.strictEqual(pm.testProviderAuthTokenMatch('sk-abc', ''), false);
  });

  test('testProviderKey 校验 key 合法性', () => {
    assert.strictEqual(pm.testProviderKey('zhipu'), true);
    assert.strictEqual(pm.testProviderKey('custom-test-123'), true);
    assert.strictEqual(pm.testProviderKey('test_key.v2'), true);
    assert.strictEqual(pm.testProviderKey(''), false);
    assert.strictEqual(pm.testProviderKey('test/key'), false);
    assert.strictEqual(pm.testProviderKey('../escape'), false);
    assert.strictEqual(pm.testProviderKey('test key'), false);
  });

  test('newCustomProviderKey 从名称生成 key', () => {
    const key1 = pm.newCustomProviderKey('My Provider', 'https://api.example.com');
    assert.strictEqual(key1, 'custom-my-provider');

    const key2 = pm.newCustomProviderKey('Provider@#$%', 'https://api.example.com');
    assert.strictEqual(key2, 'custom-provider');

    const key3 = pm.newCustomProviderKey('', 'https://api.example.com');
    assert.strictEqual(key3, 'custom-api-example-com');

    const key4 = pm.newCustomProviderKey('', 'https://api.example.com/v1/path');
    assert(key4.startsWith('custom-api-example-com-'));
    assert.strictEqual(key4.length, 'custom-api-example-com-'.length + 4);
  });

  test('getNextAvailableKey 递增 key', () => {
    // 测试空目录场景
    const fs = require('fs');
    const originalExistsSync = fs.existsSync;
    const originalReaddirSync = fs.readdirSync;

    // Mock 不存在的目录
    fs.existsSync = () => false;
    let next = pm.getNextAvailableKey('zhipu', '/mock/nonexist');
    assert.strictEqual(next, 'zhipu-2', '空目录应返回 -2');

    // Mock 有文件的目录
    fs.existsSync = () => true;
    fs.readdirSync = () => ['zhipu.json', 'zhipu-2.json', 'zhipu-4.json'];
    next = pm.getNextAvailableKey('zhipu', '/mock/dir');
    assert.strictEqual(next, 'zhipu-5', '已有 1,2,4 应返回 5');

    // 恢复原函数
    fs.existsSync = originalExistsSync;
    fs.readdirSync = originalReaddirSync;
  });

  test('getBuiltinProviderKeyFromProfileKey 解析内置 key', () => {
    const config = pm.loadProviderContract();
    assert.strictEqual(pm.getBuiltinProviderKeyFromProfileKey('zhipu'), 'zhipu');
    assert.strictEqual(pm.getBuiltinProviderKeyFromProfileKey('zhipu-2'), 'zhipu');
    assert.strictEqual(pm.getBuiltinProviderKeyFromProfileKey('zhipu-10'), 'zhipu');
    assert.strictEqual(pm.getBuiltinProviderKeyFromProfileKey('minimax'), 'minimax');
    assert.strictEqual(pm.getBuiltinProviderKeyFromProfileKey('custom-test'), '');
    assert.strictEqual(pm.getBuiltinProviderKeyFromProfileKey(''), '');
  });
});

// ============================================================================
// 3. 受管 env 层测试
// ============================================================================

suite('受管 env 层', () => {
  test('getManagedModelEnvFromLegacyAliases 旧版别名转换', () => {
    const legacy = {
      haiku: 'model-haiku-v1',
      opus: 'model-opus-v1',
      sonnet: 'model-sonnet-v1',
    };
    const result = pm.getManagedModelEnvFromLegacyAliases(legacy);
    assert.strictEqual(result.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'model-haiku-v1');
    assert.strictEqual(result.ANTHROPIC_DEFAULT_OPUS_MODEL, 'model-opus-v1');
    assert.strictEqual(result.ANTHROPIC_DEFAULT_SONNET_MODEL, 'model-sonnet-v1');
  });

  test('getManagedModelEnv 从 Profile 提取模型 env（优先 modelEnv）', () => {
    const profile = {
      modelEnv: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-from-modelEnv',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-from-modelEnv',
      },
      modelMapping: {
        haiku: 'haiku-from-legacy',
      },
      env: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-from-env',
      },
    };
    const result = pm.getManagedModelEnv(profile);
    assert.strictEqual(result.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'haiku-from-modelEnv');
    assert.strictEqual(result.ANTHROPIC_DEFAULT_OPUS_MODEL, 'opus-from-modelEnv');
  });

  test('getManagedModelEnv fallback 到 modelMapping', () => {
    const profile = {
      modelMapping: {
        haiku: 'haiku-legacy',
        opus: 'opus-legacy',
      },
    };
    const result = pm.getManagedModelEnv(profile);
    assert.strictEqual(result.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'haiku-legacy');
    assert.strictEqual(result.ANTHROPIC_DEFAULT_OPUS_MODEL, 'opus-legacy');
  });

  test('setManagedModelEnv 写入并清理旧字段', () => {
    const profile = {
      modelMapping: { haiku: 'old' },
      env: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'old-env',
        OTHER_KEY: 'keep-me',
      },
    };
    pm.setManagedModelEnv(profile, {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'new-haiku',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'new-opus',
    });
    assert(!profile.modelMapping, 'modelMapping 应被删除');
    assert.strictEqual(profile.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
    assert.strictEqual(profile.env.OTHER_KEY, 'keep-me');
    assert.strictEqual(profile.modelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'new-haiku');
    assert.strictEqual(profile.modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'new-opus');
  });

  test('getManagedExtraEnv 从 Profile.env 提取额外 env', () => {
    const profile = {
      env: {
        ANTHROPIC_MODEL: 'test-model',
        API_TIMEOUT_MS: '60000',
        OTHER_KEY: 'ignore-me',
      },
    };
    const result = pm.getManagedExtraEnv(profile);
    assert.strictEqual(result.ANTHROPIC_MODEL, 'test-model');
    assert.strictEqual(result.API_TIMEOUT_MS, '60000');
    assert.strictEqual(result.OTHER_KEY, undefined);
  });

  test('setManagedExtraEnv 清理并写入额外 env', () => {
    const profile = {
      env: {
        ANTHROPIC_MODEL: 'old',
        OTHER_KEY: 'keep-me',
      },
    };
    pm.setManagedExtraEnv(profile, {
      API_TIMEOUT_MS: '120000',
      ENABLE_TOOL_SEARCH: 'false',
    });
    assert.strictEqual(profile.env.ANTHROPIC_MODEL, undefined);
    assert.strictEqual(profile.env.OTHER_KEY, 'keep-me');
    assert.strictEqual(profile.env.API_TIMEOUT_MS, '120000');
    assert.strictEqual(profile.env.ENABLE_TOOL_SEARCH, 'false');
  });

  test('getEffectiveManagedExtraEnv 合并模板默认 + Profile 覆盖', () => {
    const profile = {
      env: {
        ANTHROPIC_MODEL: 'custom-model',
      },
    };
    const result = pm.getEffectiveManagedExtraEnv('zhipu', profile);
    // zhipu 模板有 API_TIMEOUT_MS: '3000000'
    assert.strictEqual(result.API_TIMEOUT_MS, '3000000');
    // Profile 覆盖 ANTHROPIC_MODEL
    assert.strictEqual(result.ANTHROPIC_MODEL, 'custom-model');
  });

  test('getManagedModelSummary 生成人类可读摘要', () => {
    const profile = {
      modelEnv: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-v1',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-v2',
      },
    };
    const summary = pm.getManagedModelSummary(profile);
    assert(summary.includes('Haiku 模型=haiku-v1'));
    assert(summary.includes('Opus 模型=opus-v2'));
  });

  test('getManagedModelSummary 空配置返回"未配置"', () => {
    const profile = {};
    const summary = pm.getManagedModelSummary(profile);
    assert.strictEqual(summary, '未配置');
  });
});

// ============================================================================
// 4. 数据层测试（Profile 身份匹配逻辑）
// ============================================================================

suite('数据层', () => {
  test('resolveActiveProfile 精确匹配 BaseUrl + Token', () => {
    const profiles = [
      { key: 'zhipu', baseUrl: 'https://api.zhipu.com', authToken: 'token-A' },
      { key: 'zhipu-2', baseUrl: 'https://api.zhipu.com', authToken: 'token-B' },
      { key: 'custom', baseUrl: 'https://custom.com', authToken: 'token-C' },
    ];
    const result = pm.resolveActiveProfile(profiles, 'https://api.zhipu.com', 'token-B');
    assert.strictEqual(result.key, 'zhipu-2');
  });

  test('resolveActiveProfile BaseUrl 匹配但 Token 不同返回 null', () => {
    const profiles = [
      { key: 'zhipu', baseUrl: 'https://api.zhipu.com', authToken: 'token-A' },
    ];
    const result = pm.resolveActiveProfile(profiles, 'https://api.zhipu.com', 'token-X');
    assert.strictEqual(result, null);
  });

  test('resolveActiveProfile 兼容旧 Profile（仅 BaseUrl 匹配，无 Token）', () => {
    const profiles = [
      { key: 'old-profile', baseUrl: 'https://api.old.com', authToken: '' },
    ];
    const result = pm.resolveActiveProfile(profiles, 'https://api.old.com', '');
    assert.strictEqual(result.key, 'old-profile');
  });

  test('resolveActiveProfile BaseUrl 前缀匹配', () => {
    const profiles = [
      { key: 'provider', baseUrl: 'https://api.example.com', authToken: 'token-A' },
    ];
    const result = pm.resolveActiveProfile(profiles, 'https://api.example.com/v1', 'token-A');
    assert.strictEqual(result.key, 'provider');
  });
});

// ============================================================================
// 测试总结
// ============================================================================

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`测试总数: ${testCount}`);
console.log(`通过: ${passCount} ✓`);
console.log(`失败: ${failCount} ✗`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

process.exit(failCount > 0 ? 1 : 0);
