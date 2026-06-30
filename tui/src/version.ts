// 内嵌版本号常量，供热更新版本比对使用（Phase 7.5）。
// 独立模块：core/update.ts 与入口 index.tsx 共用，避免 core 反向依赖入口——
// 入口含 non-TTY 守卫（process.exit），被 core import 会在非 TTY 下截断 verify 等下游。
// 版本号从 package.json 自动读取（单一数据源，避免手动维护版本号不一致）。
import pkg from '../package.json' with { type: 'json' };
export const CCQ_VERSION = pkg.version;
