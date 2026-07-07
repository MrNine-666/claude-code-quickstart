import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const modalSource = readFileSync(join(scriptDir, '../src/components/modal.tsx'), 'utf8');

assert.match(modalSource, /title=\{title\}/, 'Modal 应使用 OpenTUI box title 渲染标题，避免标题行被边框裁剪');
assert.match(modalSource, /titleColor=\{accent\}/, 'Modal titleColor 应跟随 tone 强调色');
assert.doesNotMatch(modalSource, /<text[\s\S]*?>\{title\}<\/text>/, 'Modal 不应再把 title 作为内容首行渲染');

console.log('[PASS] Modal 标题使用 OpenTUI box title 渲染');
