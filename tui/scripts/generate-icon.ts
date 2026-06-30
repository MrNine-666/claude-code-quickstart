#!/usr/bin/env bun
/**
 * CCQ 图标生成器
 *
 * 生成 256×256 .ico 文件，包含：
 * - Claude 橙色渐变圆角方块底（#D97757 → #C25F40）
 * - 白色 "CCQ" 粗体字母居中
 *
 * 策略：用 SVG 渲染 → sharp 转 PNG → 封装 ICO
 * 依赖：需要 sharp (npm install sharp --save-dev)
 * 产物：tui/assets/ccq-icon.ico
 */

import { writeFileSync } from "fs";
import { join } from "path";

const SIZE = 256;
const ICON_PATH = join(import.meta.dir, "../assets/ccq-icon.ico");

// Claude 橙色渐变
const GRADIENT_START = "#D97757"; // 亮橙
const GRADIENT_END = "#C25F40";   // 深橙
const TEXT_COLOR = "#FFFFFF";      // 纯白

async function generateIcon(): Promise<void> {
  console.log("🎨 开始生成 CCQ 图标...\n");

  // 1. 生成 SVG（Claude 橙渐变圆角矩形 + 白色 CCQ 文字）
  const svg = `
<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:${GRADIENT_START};stop-opacity:1" />
      <stop offset="100%" style="stop-color:${GRADIENT_END};stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" rx="32" ry="32" fill="url(#bg)" />
  <text x="50%" y="50%" font-family="Arial" font-size="120" font-weight="bold"
        fill="${TEXT_COLOR}" text-anchor="middle" dominant-baseline="middle">CCQ</text>
</svg>`.trim();

  console.log("✓ SVG 生成完成");

  // 2. 尝试导入 sharp（可选依赖）
  let sharp: any;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.error("\n❌ 需要安装 sharp:");
    console.error("   bun add -d sharp");
    process.exit(1);
  }

  // 3. SVG → PNG（sharp）
  const pngBuffer = await sharp(Buffer.from(svg))
    .resize(SIZE, SIZE)
    .png()
    .toBuffer();

  console.log(`✓ PNG 生成完成（${pngBuffer.length} 字节）`);

  // 4. 包装为 ICO 格式
  const icoBuffer = createIco(pngBuffer, SIZE);

  console.log(`✓ ICO 封装完成（${icoBuffer.length} 字节）`);

  // 5. 写入文件
  writeFileSync(ICON_PATH, icoBuffer);

  console.log(`\n✅ 图标已生成: ${ICON_PATH}`);
  console.log(`   尺寸: ${SIZE}×${SIZE}`);
  console.log(`   格式: .ico (PNG 压缩)`);
}

/**
 * 创建 ICO 文件（单一 PNG 图像）
 *
 * ICO 格式结构：
 * - ICONDIR (6 字节): 文件头
 * - ICONDIRENTRY (16 字节): 图像条目描述
 * - PNG 数据: 完整的 PNG 字节流
 */
function createIco(pngBuffer: Buffer, size: number): Buffer {
  const ICONDIR_SIZE = 6;
  const ICONDIRENTRY_SIZE = 16;
  const HEADER_SIZE = ICONDIR_SIZE + ICONDIRENTRY_SIZE;
  const icoBuffer = Buffer.alloc(HEADER_SIZE + pngBuffer.length);

  let offset = 0;

  // ICONDIR (6 字节)
  icoBuffer.writeUInt16LE(0, offset); offset += 2; // Reserved (0)
  icoBuffer.writeUInt16LE(1, offset); offset += 2; // Type (1 = ICO)
  icoBuffer.writeUInt16LE(1, offset); offset += 2; // Count (1 图像)

  // ICONDIRENTRY (16 字节)
  icoBuffer.writeUInt8(size === 256 ? 0 : size, offset); offset += 1; // Width (0 = 256)
  icoBuffer.writeUInt8(size === 256 ? 0 : size, offset); offset += 1; // Height (0 = 256)
  icoBuffer.writeUInt8(0, offset); offset += 1; // ColorCount (0 = PNG)
  icoBuffer.writeUInt8(0, offset); offset += 1; // Reserved (0)
  icoBuffer.writeUInt16LE(1, offset); offset += 2; // Planes (1)
  icoBuffer.writeUInt16LE(32, offset); offset += 2; // BitCount (32 = RGBA)
  icoBuffer.writeUInt32LE(pngBuffer.length, offset); offset += 4; // SizeInBytes
  icoBuffer.writeUInt32LE(HEADER_SIZE, offset); offset += 4; // FileOffset

  // PNG 数据
  pngBuffer.copy(icoBuffer, offset);

  return icoBuffer;
}

// 执行
generateIcon().catch((error) => {
  console.error("\n❌ 图标生成失败:", error.message);
  process.exit(1);
});
