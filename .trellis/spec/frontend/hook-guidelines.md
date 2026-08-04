# Hook and Effect Guidelines

## App-Level Detection

`use-detection-cache.ts` 拥有共享 async detection state。View 入口必须复用 App
cache，不得自动启动重复 request。

允许在以下时机 refresh：

- App 初始 detection；
- 用户显式 refresh；
- 可能已经启动的 lifecycle mutation；
- postflight reconciliation。

Reducer result 依赖最终 detection fact 时使用 `refreshAndWait()`。不得从 stale
closure dispatch success 后再 refresh。

## Input Routing

`use-manage-input.ts` 将 renderer key event 与 shell/view focus 集成。View 为活动
mode 暴露 handler；全局处理不得从活动 input、textarea、form 或 Modal 抢走按键。

在 `utils/keyboard.ts` 中统一 platform modifier。不得在每个 view 中以不同方式
检查原始 key field。

## Effect Rules

- Effect 同步 external state、detection 或 renderer capability；pure derived
  value 保持为 calculation/reducer selector。
- 每个 async effect 在 dispatch 前防护 stale completion 或 cancellation。
- Cleanup 只拥有该 effect 创建的 resource（abort controller、timer、listener）。
  不得 cancel 其他 view 的共享 request。
- Compiled mode 中，Tree-sitter initialization 在构造 worker 前退出。
- 后台 update check 更新 UI state，但不阻塞 initial render。

## Anti-Patterns

```ts
// 错误：每个 page 入口都绕过共享 cache。
useEffect(() => { void cache.refresh(); }, []);

// 正确：App 拥有 initial detection；mutation 等待最终 fact。
const finalState = await cache.refreshAndWait();
dispatch({type: 'install-reconciled', finalState});
```

## Tests

使用 deterministic injected detector/timer，并覆盖 stale response、refresh
coalescing、mutation reconciliation 与 unmount cleanup。运行
`verify-async-detection.mjs` 以及受影响的 view/domain gate。
