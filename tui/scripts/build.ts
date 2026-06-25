#!/usr/bin/env bun
/**
 * TUI 构建脚本 - 交叉编译 4 平台可执行文件
 *
 * 产物：
 * - dist/ccq-windows-x64.exe
 * - dist/ccq-windows-arm64.exe
 * - dist/ccq-darwin-x64
 * - dist/ccq-darwin-arm64
 *
 * 契约内嵌：通过 src/core/embedded-contracts.ts 静态 import 内嵌
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const TARGETS = [
  { platform: "windows", arch: "x64", ext: ".exe" },
  { platform: "windows", arch: "arm64", ext: ".exe" },
  { platform: "darwin", arch: "x64", ext: "" },
  { platform: "darwin", arch: "arm64", ext: "" },
] as const;

const DIST_DIR = join(import.meta.dir, "../dist");
const SRC_ENTRY = join(import.meta.dir, "../src/index.tsx");

async function buildTarget(
  platform: string,
  arch: string,
  ext: string
): Promise<void> {
  const target = `bun-${platform}-${arch}`;
  const outfile = join(DIST_DIR, `ccq-${platform}-${arch}${ext}`);

  console.log(`\n🔨 构建 ${target}...`);
  console.log(`   入口: ${SRC_ENTRY}`);
  console.log(`   产物: ${outfile}`);

  const proc = Bun.spawn([
    "bun",
    "build",
    "--compile",
    `--target=${target}`,
    `--outfile=${outfile}`,
    SRC_ENTRY,
  ], {
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`构建 ${target} 失败，退出码: ${exitCode}`);
  }

  console.log(`✓ ${target} 构建完成`);
}

async function main(): Promise<void> {
  console.log("🚀 开始构建 TUI 可执行文件...\n");
  console.log(`工作目录: ${import.meta.dir}`);
  console.log(`产物目录: ${DIST_DIR}`);

  // 创建 dist 目录
  if (!existsSync(DIST_DIR)) {
    console.log(`\n📁 创建产物目录: ${DIST_DIR}`);
    mkdirSync(DIST_DIR, { recursive: true });
  }

  // 交叉编译 4 个平台
  for (const { platform, arch, ext } of TARGETS) {
    await buildTarget(platform, arch, ext);
  }

  console.log("\n✅ 所有平台构建完成！");
  console.log("\n产物列表:");
  for (const { platform, arch, ext } of TARGETS) {
    console.log(`  - ccq-${platform}-${arch}${ext}`);
  }
}

main().catch((error) => {
  console.error("\n❌ 构建失败:", error.message);
  process.exit(1);
});
