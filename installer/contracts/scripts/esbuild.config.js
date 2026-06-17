#!/usr/bin/env node
/**
 * esbuild 配置 - Manage JS 单文件 bundle 构建
 *
 * 职责：
 * - 将 manage.js + 4 个子管理器打包为单文件 bundle
 * - 目标：dist/manage.js（~150KB 以内）
 * - 平台：Node.js
 * - 目标版本：Node 20+
 *
 * @author 哈雷酱（傲娇大小姐工程师）
 * @version 1.0.0
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// 路径配置
const ROOT_DIR = path.resolve(__dirname, '../../..');
const CONTRACTS_SCRIPTS_DIR = path.resolve(__dirname);
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// 确保 dist 目录存在
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

// esbuild 配置
const buildConfig = {
  entryPoints: [path.join(CONTRACTS_SCRIPTS_DIR, 'manage.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: path.join(DIST_DIR, 'manage.js'),
  minify: true,  // P10 任务 8.4：bundle 瘦身（minifyIdentifiers + minifySyntax + minifyWhitespace），为 150KB 上限预留空间
  sourcemap: false,
  format: 'cjs',  // CommonJS 格式
  external: [],   // 不排除任何内置模块，全部打包
  logLevel: 'info'
};

// 执行构建
async function build() {
  try {
    console.log('🔨 开始构建 manage.js bundle...');
    console.log(`📁 入口: ${buildConfig.entryPoints[0]}`);
    console.log(`📦 输出: ${buildConfig.outfile}`);

    const result = await esbuild.build(buildConfig);

    // 检查 bundle 大小
    const stats = fs.statSync(buildConfig.outfile);
    const sizeKB = (stats.size / 1024).toFixed(2);
    const sizeLimit = 150;

    console.log(`✅ 构建成功！`);
    console.log(`📊 Bundle 大小: ${sizeKB} KB`);

    if (stats.size / 1024 > sizeLimit) {
      console.error(`❌ 错误: Bundle 大小 ${sizeKB} KB 超过限制 ${sizeLimit} KB`);
      process.exit(1);
    }

    console.log(`✅ Bundle 大小检查通过（< ${sizeLimit} KB）`);
  } catch (error) {
    console.error('❌ 构建失败:', error);
    process.exit(1);
  }
}

// 执行构建
if (require.main === module) {
  build().catch((err) => {
    console.error('❌ 未捕获异常:', err);
    process.exit(1);
  });
}

module.exports = { build, buildConfig };
