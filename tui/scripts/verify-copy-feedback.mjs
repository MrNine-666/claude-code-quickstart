import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// 复制反馈统一入口门禁（HC-COPY-FEEDBACK）：
// 所有 OSC52 复制必须走 copyTextWithFeedback，成功即弹 toast，失败 / 不支持时静默。
// 覆盖 copy-on-select（index.tsx selection 事件）与编辑态 Cmd/Ctrl+C（textarea-edit-keys）。

const copyFeedbackSource = readFileSync(new URL('../src/utils/copy-feedback.ts', import.meta.url), 'utf8');
assert.match(copyFeedbackSource, /renderer\.isOsc52Supported\(\)/, 'copyTextWithFeedback 必须先判 isOsc52Supported 再复制');
assert.match(copyFeedbackSource, /renderer\.copyToClipboardOSC52\(text\)/, 'copyTextWithFeedback 必须走 OSC52 复制');
assert.match(copyFeedbackSource, /toast\.success\('已复制到剪贴板'/, '复制成功必须弹「已复制到剪贴板」toast 反馈');
assert.match(copyFeedbackSource, /text\.length === 0/, '空文本必须静默跳过（不弹 toast）');

// index.tsx：copy-on-select 必须经 copyTextWithFeedback，不得直接裸调 copyToClipboardOSC52。
const indexSource = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
assert.match(indexSource, /copyTextWithFeedback\(renderer, selection\.getSelectedText\(\)\)/, 'copy-on-select 必须经 copyTextWithFeedback 统一入口');

// textarea-edit-keys：编辑态 Cmd/Ctrl+C 复制必须经 copyTextWithFeedback。
const editKeysSource = readFileSync(new URL('../src/components/editor/textarea-edit-keys.ts', import.meta.url), 'utf8');
assert.match(editKeysSource, /copyTextWithFeedback\(renderer, textarea\.getSelectedText\(\)\)/, '编辑态 Cmd/Ctrl+C 必须经 copyTextWithFeedback 统一入口');
assert.doesNotMatch(editKeysSource, /renderer\.copyToClipboardOSC52\(/, 'textarea-edit-keys 不得再裸调 copyToClipboardOSC52（已收口到 copyTextWithFeedback）');

console.log('[PASS] 复制反馈统一入口：copy-on-select + 编辑态 Cmd/Ctrl+C 均经 copyTextWithFeedback，成功弹 toast');
