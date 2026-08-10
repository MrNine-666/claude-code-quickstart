#!/usr/bin/env bun
/**
 * TUI 构建脚本 - 默认交叉编译 4 平台，也可通过 --target=<id> 只构建一个目标
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

import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { gzipAssetNameForRaw, packageGzipAsset } from "./package-gzip-assets.ts";

export const BUILD_TARGETS = [
  { id: "windows-x64", platform: "windows", arch: "x64", ext: ".exe", icon: true },
  { id: "windows-arm64", platform: "windows", arch: "arm64", ext: ".exe", icon: false },
  { id: "macos-x64", platform: "macos", arch: "x64", ext: "", icon: false },
  { id: "macos-arm64", platform: "macos", arch: "arm64", ext: "", icon: false },
] as const;

export type BuildTarget = (typeof BUILD_TARGETS)[number];
export type BuildTargetRunner = (target: BuildTarget) => Promise<void>;

const TARGETS_BY_ID = new Map<string, BuildTarget>(BUILD_TARGETS.map(target => [target.id, target]));
const TARGET_USAGE = `用法: bun scripts/build.ts [--target=${BUILD_TARGETS.map(target => target.id).join("|")}]`;

const DIST_DIR = join(import.meta.dir, "../../dist");
const SRC_ENTRY = join(import.meta.dir, "../src/index.tsx");
const ICON_PATH = join(import.meta.dir, "../assets/ccq-icon.ico");

export function targetArtifactNames(target: BuildTarget): { readonly raw: string; readonly gzip: string } {
  const raw = `ccq-${target.platform}-${target.arch}${target.ext}`;
  return { raw, gzip: gzipAssetNameForRaw(raw) };
}

export function cleanTargetArtifacts(target: BuildTarget, directory = DIST_DIR): void {
  const artifacts = targetArtifactNames(target);
  rmSync(join(directory, artifacts.raw), { force: true });
  rmSync(join(directory, artifacts.gzip), { force: true });
}

export function selectBuildTargets(args: readonly string[]): readonly BuildTarget[] {
  if (args.length === 0) return BUILD_TARGETS;

  const targetArguments = args.filter(argument => argument === "--target" || argument.startsWith("--target="));
  if (targetArguments.length > 1) {
    throw new Error(`只能选择一个 target，不能重复传入 --target。${TARGET_USAGE}`);
  }
  if (args.length !== 1) {
    throw new Error(`不支持额外参数。${TARGET_USAGE}`);
  }

  const argument = args[0];
  if (argument === undefined) {
    throw new Error(TARGET_USAGE);
  }
  if (argument === "--target" || argument === "--target=") {
    throw new Error(`--target 需要值。${TARGET_USAGE}`);
  }
  if (!argument.startsWith("--target=")) {
    throw new Error(`不支持参数: ${argument}。${TARGET_USAGE}`);
  }

  const targetId = argument.slice("--target=".length);
  const target = TARGETS_BY_ID.get(targetId);
  if (!target) {
    throw new Error(`未知 target: ${targetId}。${TARGET_USAGE}`);
  }
  return [target];
}

async function compileTarget(target: BuildTarget): Promise<void> {
  const bunTarget = `bun-${target.platform}-${target.arch}`;
  const artifacts = targetArtifactNames(target);
  const outfile = join(DIST_DIR, artifacts.raw);

  cleanTargetArtifacts(target);

  console.log(`\n🔨 构建 ${bunTarget}...`);
  console.log(`   入口: ${SRC_ENTRY}`);
  console.log(`   产物: ${outfile}`);

  // --no-compile-autoload-dotenv：编译产物默认会读取「运行目录」下的 .env（Bun 默认 autoload
  // 开启）。若用户 cwd 恰好有一个写着 CCQ_DEBUG=1 的 .env，生产版会意外弹出调试控制台。
  // 关掉 autoload 后，生产二进制对任何 .env 免疫，调试控制台只能在源码 dev 模式下开启。
  const args = [
    "bun",
    "build",
    "--compile",
    "--no-compile-autoload-dotenv",
    `--target=${bunTarget}`,
    `--outfile=${outfile}`
  ];

  // Bun 限制：--windows-icon 只能在 Windows 本机构建时使用，不支持交叉编译。
  const isWindows = process.platform === "win32";
  if (target.icon && isWindows && existsSync(ICON_PATH)) {
    args.push(`--windows-icon=${ICON_PATH}`);
    console.log(`   图标: ${ICON_PATH}`);
  } else if (target.icon && !isWindows) {
    console.log(`   ⚠️  跳过图标嵌入（交叉编译限制：--windows-icon 仅支持 Windows 本机构建）`);
  } else if (target.icon) {
    console.warn(`   ⚠️  图标文件不存在，跳过: ${ICON_PATH}`);
  }

  args.push(SRC_ENTRY);

  const proc = Bun.spawn(args, {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`构建 ${bunTarget} 失败，退出码: ${exitCode}`);
  }

  console.log(`✓ ${bunTarget} 构建完成`);
}

async function buildAndPackageTarget(target: BuildTarget): Promise<void> {
  await compileTarget(target);

  // gzip 必须在最终 raw 字节（含图标/版本注入）之后生成。
  const artifacts = targetArtifactNames(target);
  const gzipResult = packageGzipAsset(join(DIST_DIR, artifacts.raw), join(DIST_DIR, artifacts.gzip));
  const saved = ((1 - gzipResult.gzipSize / gzipResult.rawSize) * 100).toFixed(2);
  console.log(`✓ ${artifacts.gzip} ${gzipResult.gzipSize} B (−${saved}%)`);
}

export async function runBuildTargets(
  targets: readonly BuildTarget[],
  buildTarget: BuildTargetRunner = buildAndPackageTarget
): Promise<void> {
  const results: Array<{ target: BuildTarget; success: boolean; error?: string }> = [];

  for (const target of targets) {
    try {
      await buildTarget(target);
      results.push({ target, success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`\n⚠️  ${target.id} 构建失败: ${errorMessage}`);
      results.push({ target, success: false, error: errorMessage });

      // 默认四目标本地构建保留 arm64 已知限制的兼容行为。
      if (target.arch === "arm64" && targets.length > 1) {
        console.log(`   → arm64 交叉编译失败是已知限制，继续构建其他平台...\n`);
      }
    }
  }

  console.log("\n✅ 构建完成！\n");
  console.log("产物列表:");
  for (const { target, success, error } of results) {
    if (success) {
      console.log(`  ✓ ccq-${target.id}${target.platform === "windows" ? ".exe" : ""}`);
    } else {
      console.log(`  ✗ ccq-${target.id}${target.platform === "windows" ? ".exe" : ""} (${error})`);
    }
  }

  const successCount = results.filter(result => result.success).length;
  if (successCount === 0) {
    throw new Error("所有选定平台构建均失败");
  }

  console.log(`\n成功: ${successCount}/${results.length} 个平台`);
}

export async function main(targets: readonly BuildTarget[]): Promise<void> {
  console.log("🚀 开始构建 TUI 可执行文件...\n");
  console.log(`工作目录: ${import.meta.dir}`);
  console.log(`产物目录: ${DIST_DIR}`);

  if (!existsSync(DIST_DIR)) {
    console.log(`\n📁 创建产物目录: ${DIST_DIR}`);
    mkdirSync(DIST_DIR, { recursive: true });
  }

  await runBuildTargets(targets);
}

if (import.meta.main) {
  try {
    const targets = selectBuildTargets(process.argv.slice(2));
    await main(targets);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("\n❌ 构建失败:", message);
    process.exitCode = 1;
  }
}
