#!/usr/bin/env bun
/**
 * TUI 构建脚本 - 交叉编译 4 平台可执行文件
 *
 * 产物：
 * - dist/ccq-windows-x64.exe（带自定义图标）
 * - dist/ccq-windows-arm64.exe（交叉编译限制，保留 Bun 默认图标）
 * - dist/ccq-macos-x64
 * - dist/ccq-macos-arm64
 *
 * 契约内嵌：通过 src/core/embedded-contracts.ts 静态 import 内嵌
 * 图标：Windows x64 本机构建时自动嵌入 assets/ccq-icon.ico
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const TARGETS = [
  { platform: "windows", arch: "x64", ext: ".exe", icon: true },
  { platform: "windows", arch: "arm64", ext: ".exe", icon: false }, // 交叉编译限制
  { platform: "macos", arch: "x64", ext: "", icon: false },
  { platform: "macos", arch: "arm64", ext: "", icon: false },
] as const;

const DIST_DIR = join(import.meta.dir, "../../dist");
const SRC_ENTRY = join(import.meta.dir, "../src/index.tsx");
const ICON_PATH = join(import.meta.dir, "../assets/ccq-icon.ico");

async function buildTarget(
  platform: string,
  arch: string,
  ext: string,
  useIcon: boolean
): Promise<void> {
  const target = `bun-${platform}-${arch}`;
  const outfile = join(DIST_DIR, `ccq-${platform}-${arch}${ext}`);

  console.log(`\n🔨 构建 ${target}...`);
  console.log(`   入口: ${SRC_ENTRY}`);
  console.log(`   产物: ${outfile}`);

  const args = [
    "bun",
    "build",
    "--compile",
    `--target=${target}`,
    `--outfile=${outfile}`,
  ];

  // Windows x64 + 图标文件存在 + 本机是 Windows → 添加 --windows-icon
  // Bun 限制：--windows-icon 只能在 Windows 本机构建时使用，不支持交叉编译
  const isWindows = process.platform === "win32";
  if (useIcon && isWindows && existsSync(ICON_PATH)) {
    args.push(`--windows-icon=${ICON_PATH}`);
    console.log(`   图标: ${ICON_PATH}`);
  } else if (useIcon && !isWindows) {
    console.log(`   ⚠️  跳过图标嵌入（交叉编译限制：--windows-icon 仅支持 Windows 本机构建）`);
  } else if (useIcon) {
    console.warn(`   ⚠️  图标文件不存在，跳过: ${ICON_PATH}`);
  }

  args.push(SRC_ENTRY);

  const proc = Bun.spawn(args, {
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

  // 交叉编译 4 个平台（arm64 失败不中断）
  const results: Array<{ target: string; success: boolean; error?: string }> = [];

  for (const { platform, arch, ext, icon } of TARGETS) {
    const target = `${platform}-${arch}`;
    try {
      await buildTarget(platform, arch, ext, icon);
      results.push({ target, success: true });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`\n⚠️  ${target} 构建失败: ${errMsg}`);
      results.push({ target, success: false, error: errMsg });

      // arm64 交叉编译失败属于已知限制，不中断流程
      if (arch === "arm64") {
        console.log(`   → arm64 交叉编译失败是已知限制，继续构建其他平台...\n`);
      }
    }
  }

  console.log("\n✅ 构建完成！\n");
  console.log("产物列表:");
  for (const { target, success, error } of results) {
    if (success) {
      console.log(`  ✓ ccq-${target}${target.startsWith("windows") ? ".exe" : ""}`);
    } else {
      console.log(`  ✗ ccq-${target}${target.startsWith("windows") ? ".exe" : ""} (${error})`);
    }
  }

  // 至少一个平台成功即视为构建成功
  const successCount = results.filter(r => r.success).length;
  if (successCount === 0) {
    throw new Error("所有平台构建均失败");
  }

  console.log(`\n成功: ${successCount}/${results.length} 个平台`);
}

main().catch((error) => {
  console.error("\n❌ 构建失败:", error.message);
  process.exit(1);
});
