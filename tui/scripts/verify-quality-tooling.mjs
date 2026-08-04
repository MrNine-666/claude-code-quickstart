import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const root = join(import.meta.dirname, '..');
const repoRoot = join(root, '..');
const read = path => readFileSync(path, 'utf8');
const pkg = JSON.parse(read(join(root, 'package.json')));
const biome = JSON.parse(read(join(root, 'biome.json')));
const formatter = read(join(root, 'scripts', 'biome-format.mjs'));
const workflow = read(join(repoRoot, '.github', 'workflows', 'tui-quality.yml'));
const coreTest = read(join(root, 'tests', 'core', 'text-utils.test.ts'));
const rendererTest = read(join(root, 'tests', 'components', 'status-dot.test.tsx'));

assert.equal(pkg.packageManager, 'bun@1.3.14');
assert.equal(pkg.devDependencies['@biomejs/biome'], '2.5.4');
assert.equal(pkg.dependencies['@opentui/core'], '0.4.5');
assert.equal(pkg.dependencies['@opentui/keymap'], '0.4.5');
assert.equal(pkg.dependencies['@opentui/react'], '0.4.5');
assert.equal(pkg.scripts.format, 'bun scripts/biome-format.mjs --write');
assert.equal(pkg.scripts['format:check'], 'bun scripts/biome-format.mjs');
assert.equal(pkg.scripts.lint, 'biome lint --diagnostic-level=error src scripts tests');
assert.equal(pkg.scripts.test, 'bun test tests');
assert.match(pkg.scripts.verify, /bun scripts\/verify-build-runtime\.mjs/);
assert.equal(pkg.scripts.check, 'bun run format:check && bun run lint && bun run typecheck && bun run test && bun run verify');
assert.equal(JSON.stringify({...pkg.dependencies, ...pkg.devDependencies}).match(/vite|vitest/i), null);

assert.equal(biome.formatter.indentStyle, 'tab');
assert.equal(biome.javascript.formatter.quoteStyle, 'single');
assert.equal(biome.linter.rules.recommended, true);
assert.match(formatter, /CCQ_FORMAT_BASE/);
assert.match(formatter, /\$\{base\}\.\.\.HEAD/);
assert.match(formatter, /'--cached'/);
assert.match(formatter, /'ls-files', '--others', '--exclude-standard'/);
assert.match(formatter, /'rev-parse', '--show-prefix'/);
assert.match(formatter, /normalized\.startsWith\(gitPrefix\)/);
assert.match(formatter, /'src', 'tests'/);

assert.match(workflow, /pull_request:/);
assert.match(workflow, /push:[\s\S]*branches:[\s\S]*- main/);
assert.match(workflow, /contents: read/);
assert.match(workflow, /runs-on: macos-latest/);
assert.match(workflow, /fetch-depth: 0/);
assert.match(workflow, /bun-version: '1\.3\.14'/);
assert.match(workflow, /bun install --frozen-lockfile/);
assert.match(workflow, /CCQ_FORMAT_BASE:/);
assert.match(workflow, /run: bun run check/);
assert.doesNotMatch(workflow, /upload-artifact|action-gh-release|contents: write/);

assert.match(coreTest, /from 'bun:test'/);
assert.match(rendererTest, /testRender/);
assert.match(rendererTest, /finally/);
assert.match(rendererTest, /renderer\.destroy\(\)/);

console.log('[PASS] TUI quality tooling：Biome/Bun test/aggregate gate/CI contract');
