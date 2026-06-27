// 内嵌版本号常量，供热更新版本比对使用（Phase 7.5）。
// 独立模块：core/update.ts 与入口 index.tsx 共用，避免 core 反向依赖入口——
// 入口含 non-TTY 守卫（process.exit），被 core import 会在非 TTY 下截断 verify 等下游。
export const CCQ_VERSION = '0.1.0';
