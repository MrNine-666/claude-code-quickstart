import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

const src = name => new URL(`../src/${name}`, import.meta.url);
const read = name => readFileSync(src(name), 'utf8');

const expectedFiles = [
	'views/provider/ProviderView.tsx',
	'views/provider/ProviderHomeView.tsx',
	'views/provider/ProviderFormView.tsx',
	'views/provider/provider-form-adapter.ts',
	'views/mcp/McpView.tsx',
	'views/mcp/McpHomeView.tsx',
	'views/mcp/McpFormView.tsx',
	'views/mcp/mcp-view-actions.ts',
	'views/config/ConfigView.tsx',
	'views/prompts/PromptsView.tsx',
	'components/managed-document/ManagedDocumentView.tsx',
	'components/managed-document/DocumentHomeView.tsx',
	'components/managed-document/DocumentFormView.tsx',
	'views/tools/ToolsView.tsx',
	'views/tools/ToolsHomeView.tsx',
	'views/tools/ToolsModals.tsx',
	'views/tools/tools-view-actions.ts',
	'views/tools/tools-view-input.ts',
	'views/tools/tools-view-services.ts',
	'views/skills/SkillsView.tsx',
	'views/skills/SkillsHomeView.tsx',
	'views/skills/SkillsInstallView.tsx',
	'views/skills/SkillsModals.tsx',
	'views/skills/skills-view-actions.ts',
	'views/skills/skills-view-input.ts',
	'views/skills/skills-view-services.ts',
	'types/provider-form-adapter.ts'
];
for (const file of expectedFiles) assert.equal(existsSync(src(file)), true, `架构文件必须存在：${file}`);

const removedFiles = [
	'views/ConfigView.tsx',
	'views/PromptsView.tsx',
	'views/ToolsView.tsx',
	'views/SkillsView.tsx',
	'views/provider-view.tsx',
	'views/provider-form.tsx',
	'views/tools-view-services.ts',
	'views/skills-view-services.ts'
];
for (const file of removedFiles) assert.equal(existsSync(src(file)), false, `旧平铺入口不得保留：${file}`);

const roots = {
	provider: ['views/provider/ProviderView.tsx', ['ProviderHomeView', 'ProviderFormView']],
	mcp: ['views/mcp/McpView.tsx', ['McpHomeView', 'McpFormView']],
	tools: ['views/tools/ToolsView.tsx', ['ToolsHomeView', 'ToolsModals']],
	skills: ['views/skills/SkillsView.tsx', ['SkillsHomeView', 'SkillsInstallView', 'SkillsModals']]
};
for (const [name, [file, children]] of Object.entries(roots)) {
	const source = read(file);
	for (const child of children) assert.match(source, new RegExp(child), `${name} Root 必须编排 ${child}`);
	assert.doesNotMatch(source, /<(?:FormPanel|ScrollList|Card)\b/, `${name} Root 不得内联主页/表单控件 JSX`);
}

for (const file of ['views/config/ConfigView.tsx', 'views/prompts/PromptsView.tsx']) {
	assert.match(read(file), /ManagedDocumentView/, `${file} 必须复用共享 managed-document 深模块`);
}
for (const file of ['components/managed-document/ManagedDocumentView.tsx']) {
	const source = read(file);
	assert.match(source, /DocumentHomeView/, `${file} 必须编排 DocumentHomeView`);
	assert.match(source, /DocumentFormView/, `${file} 必须编排 DocumentFormView`);
}

const pageFiles = [
	'views/provider/ProviderHomeView.tsx',
	'views/provider/ProviderFormView.tsx',
	'views/mcp/McpHomeView.tsx',
	'views/mcp/McpFormView.tsx',
	'views/tools/ToolsHomeView.tsx',
	'views/tools/ToolsModals.tsx',
	'views/skills/SkillsHomeView.tsx',
	'views/skills/SkillsInstallView.tsx',
	'views/skills/SkillsModals.tsx'
];
const stripTypeImports = source => source.replace(/import\s+type[\s\S]*?from\s+['"][^'"]+['"];?/g, '');
for (const file of pageFiles) {
	const source = stripTypeImports(read(file));
	assert.doesNotMatch(source, /from\s+['"](?:\.\.\/)+services\/(?:provider-service|codex-service|mcp-service|skills-service|skills-adoption|tools-service)\.js['"]/, `${file} 不得直接编排写操作 service`);
	assert.doesNotMatch(source, /from\s+['"]node:(?:fs|child_process)['"]|from\s+['"](?:fs|child_process)['"]/, `${file} 不得直接读写文件或启动进程`);
}

assert.doesNotMatch(read('services/codex-service.ts'), /from\s+['"][^'"]*views\//, 'codex-service 不得反向依赖 view 类型');
const appSource = read('app.tsx');
for (const path of ['./views/provider/ProviderView.js', './views/mcp/McpView.js', './views/config/ConfigView.js', './views/prompts/PromptsView.js', './views/tools/ToolsView.js', './views/skills/SkillsView.js']) {
	assert.match(appSource, new RegExp(`from ['"]${path.replaceAll('.', '\\.')}`), `App 必须从新 domain 入口导入 ${path}`);
}
assert.doesNotMatch(appSource, /views\/(?:SkillsView|ToolsView|ConfigView|PromptsView|provider-view|provider-form)\.js/, 'App 不得导入旧平铺 view 入口');

console.log('[PASS] View domain topology、Root/Home/Form 所有权、共享文档复用与 service 依赖方向');
