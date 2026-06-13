#!/usr/bin/env node
/**
 * skills-discovery.js — Skills 动态发现与状态判定
 *
 * 职责（纯算法层）：
 *   - 解析 `npx skills add --list` 输出（ANSI 清理）
 *   - 计算安装状态（discovered vs installed 交集）
 *   - 批量状态判定（Installed / Partial / NotInstalled）
 *
 * 平台层保留：
 *   - 菜单 UI
 *   - npx 进程启动
 *   - 缓存文件读写
 *   - release artifact 中 contracts/scripts 不可用时的 runtime fallback
 *
 * 注意：本脚本是纯算法辅助，不是 Windows/macOS release 单文件的必需依赖。
 * 跨平台业务策略优先放在 skills.json；平台 runtime 必须保留 fallback。
 */

const fs = require('fs');

// ─── ANSI 清理 ───────────────────────────────────────────────────────────────

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

// ─── --list 输出解析 ─────────────────────────────────────────────────────────

function parseSkillsListOutput(text) {
  const cleaned = stripAnsi(text);
  const lines = cleaned.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  const names = [];

  for (const line of lines) {
    // 跳过空行、提示信息、警告、进度条
    if (!line ||
        line.startsWith('Need to install') ||
        line.startsWith('Installing') ||
        line.startsWith('Installed') ||
        line.startsWith('Ok to proceed') ||
        line.startsWith('✔') ||
        line.startsWith('⠋') ||
        line.startsWith('⠙') ||
        line.startsWith('⠹') ||
        line.startsWith('⠸') ||
        line.startsWith('⠼') ||
        line.startsWith('⠴') ||
        line.startsWith('⠦') ||
        line.startsWith('⠧') ||
        line.startsWith('⠇') ||
        line.startsWith('⠏') ||
        line.includes('to proceed') ||
        line.match(/^\d+\.\d+\.\d+/) || // 版本号行
        /^[@a-z0-9\-\/]+@\d+\.\d+\.\d+$/.test(line) // npm 包名@版本
    ) {
      continue;
    }

    // 提取有效 skill name（字母、数字、连字符、斜杠）
    const match = line.match(/^([a-z0-9\-\/]+)$/i);
    if (match && !names.includes(match[1])) {
      names.push(match[1]);
    }
  }

  return names;
}

// ─── 状态判定 ────────────────────────────────────────────────────────────────

function computeInstallStatus(discovered, installed) {
  const discoveredSet = new Set(discovered);
  const installedSet = new Set(installed);

  if (discoveredSet.size === 0) {
    return 'Unknown';
  }

  const installedCount = discovered.filter(name => installedSet.has(name)).length;

  if (installedCount === 0) {
    return 'NotInstalled';
  } else if (installedCount === discovered.length) {
    return 'Installed';
  } else {
    return 'Partial';
  }
}

// ─── 批量状态判定 ────────────────────────────────────────────────────────────

function computeBatchStatus(catalogueWithDiscovered, installedSkills) {
  const installedSet = new Set(installedSkills);
  const results = [];

  for (const entry of catalogueWithDiscovered) {
    const discovered = entry.discovered || [];
    const status = computeInstallStatus(discovered, installedSkills);

    results.push({
      id: entry.id,
      name: entry.name,
      source: entry.source,
      discovered: discovered,
      installedCount: discovered.filter(name => installedSet.has(name)).length,
      totalCount: discovered.length,
      status: status
    });
  }

  return results;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { mode: 'parse', input: '' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && i + 1 < args.length) {
      parsed.mode = args[++i];
    } else if (args[i] === '--input' && i + 1 < args.length) {
      parsed.input = args[++i];
    } else if (args[i] === '--catalogue' && i + 1 < args.length) {
      parsed.catalogue = args[++i];
    } else if (args[i] === '--installed' && i + 1 < args.length) {
      parsed.installed = args[++i];
    }
  }

  return parsed;
}

function main() {
  const args = parseArgs();

  if (args.mode === 'parse') {
    // 模式 1: 解析 --list 输出
    if (!args.input) {
      console.error('Error: --input required for parse mode');
      process.exit(1);
    }

    let text;
    if (args.input === '-') {
      // 从 stdin 读取
      const chunks = [];
      process.stdin.on('data', chunk => chunks.push(chunk));
      process.stdin.on('end', () => {
        text = Buffer.concat(chunks).toString('utf8');
        const names = parseSkillsListOutput(text);
        console.log(JSON.stringify({ names }, null, 2));
      });
      return;
    } else {
      // 从文件读取
      text = fs.readFileSync(args.input, 'utf8');
    }

    const names = parseSkillsListOutput(text);
    console.log(JSON.stringify({ names }, null, 2));

  } else if (args.mode === 'status') {
    // 模式 2: 批量状态判定
    if (!args.catalogue || !args.installed) {
      console.error('Error: --catalogue and --installed required for status mode');
      process.exit(1);
    }

    const catalogue = JSON.parse(fs.readFileSync(args.catalogue, 'utf8'));
    const installed = JSON.parse(fs.readFileSync(args.installed, 'utf8'));

    const results = computeBatchStatus(catalogue, installed);
    console.log(JSON.stringify({ results }, null, 2));

  } else {
    console.error(`Error: Unknown mode "${args.mode}". Use "parse" or "status".`);
    process.exit(1);
  }
}

main();
