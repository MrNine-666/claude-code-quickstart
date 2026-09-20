import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
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
	assert.doesNotMatch(
		source,
		/from\s+['"](?:\.\.\/)+services\/(?:provider-service|codex-service|mcp-service|skills-service|skills-adoption|tools-service)\.js['"]/,
		`${file} 不得直接编排写操作 service`
	);
	assert.doesNotMatch(
		source,
		/from\s+['"]node:(?:fs|child_process)['"]|from\s+['"](?:fs|child_process)['"]/,
		`${file} 不得直接读写文件或启动进程`
	);
}

assert.doesNotMatch(read('services/codex-service.ts'), /from\s+['"][^'"]*views\//, 'codex-service 不得反向依赖 view 类型');
const appSource = read('app.tsx');
for (const path of [
	'./views/provider/ProviderView.js',
	'./views/mcp/McpView.js',
	'./views/config/ConfigView.js',
	'./views/prompts/PromptsView.js',
	'./views/tools/ToolsView.js',
	'./views/skills/SkillsView.js'
]) {
	assert.match(appSource, new RegExp(`from ['"]${path.replaceAll('.', '\\.')}`), `App 必须从新 domain 入口导入 ${path}`);
}
assert.doesNotMatch(
	appSource,
	/views\/(?:SkillsView|ToolsView|ConfigView|PromptsView|provider-view|provider-form)\.js/,
	'App 不得导入旧平铺 view 入口'
);

console.log('[PASS] View domain topology、Root/Home/Form 所有权、共享文档复用与 service 依赖方向');
// ═══════════════════════════════════════════════════════════════════════════
// P1-G1 静态合同并入门禁（迁自 verify-extensions-view.mjs / verify-shortcuts.mjs）
// B 类：有 spec 背书、但无进程内行为等价物的静态不变量。
// 每条保留原语义与错误消息（消息写明破掉会怎样）。
// ═══════════════════════════════════════════════════════════════════════════

const archExtensionsViewSource = read('views/extensions/ExtensionsView.tsx');
const archExtensionsInputSource = read('views/extensions/extensions-view-input.ts');
const archExtensionsAppSource = read('app.tsx');
const archExtensionsCardSource = read('components/card.tsx');
const archExtensionsKeybindingsSource = read('config/keybindings.ts');
const archExtensionsShortcutsSource = read('state/shortcuts.ts');
const archExtensionsConfirmSource = archExtensionsViewSource.slice(
	archExtensionsViewSource.indexOf('function ExtensionConfirmModal'),
	archExtensionsViewSource.indexOf('async function runConfirmed')
);
const archProviderFormSource = read('views/provider/ProviderFormView.tsx');
const archPiSelectionPanelSource = read('views/provider/pi-model-selection-panel.tsx');
const archProviderViewSource = read('views/provider/ProviderView.tsx');
const archFormPanelSource = read('components/form/FormPanel.tsx');
const archModelSelectSource = read('components/form/ModelSelectField.tsx');
const archSkillsViewSource = read('views/skills/SkillsModals.tsx');
const archToolsViewSource = read('views/tools/ToolsView.tsx');
const archToolsInputSource = read('views/tools/tools-view-input.ts');
const archSingleModelKeyStart = archProviderFormSource.indexOf('const handleSingleModelKey');
const archFormKeyStart = archProviderFormSource.indexOf('const handleFormKey');
const archPiSourceKeyStart = archProviderFormSource.indexOf('const handlePiSourceModeKey');
const archModelFocusKeyStart = archProviderFormSource.indexOf('const handleModelFocusKey');
const archSingleModelSelectStart = archProviderFormSource.indexOf('const handleSingleModelSelect');

// ── 迁自 verify-extensions-view.mjs（扩展域静态合同）────────────────────────
assert.match(archExtensionsViewSource, /<SingleLineInput/);
assert.match(archExtensionsViewSource, /height=\{3\} maxHeight=\{3\} overflow="hidden"/, '扩展简介必须限制为三行并裁剪溢出');
assert.match(archExtensionsViewSource, /formatMonthlyDownloads/);
assert.match(archExtensionsViewSource, /onSubmit=\{value =>/, '扩展搜索必须使用原生 input 提交回调');
assert.match(archExtensionsViewSource, /onFocus=\{focusSearch\}/, '扩展搜索必须把鼠标点击同步为搜索焦点');
assert.match(archExtensionsViewSource, /<span fg=\{colors\.primary\}>\{item\.author/, '作者必须使用主题主色');
assert.match(archExtensionsViewSource, /<span fg=\{colors\.success\}>\{`\$\{formatMonthlyDownloads/, '月下载量必须使用主题成功色');
assert.match(
	archExtensionsViewSource,
	/<span fg=\{colors\.muted\} attributes=\{TextAttributes\.DIM\}>[\s\S]*formatPublishedAge/,
	'发布时间必须使用主题弱化色'
);
assert.match(archExtensionsViewSource, /<span fg=\{colors\.warning\}>\{piResourceLabel/, '资源类型必须使用主题警告色');
assert.match(archExtensionsViewSource, /<span fg=\{colors\.primaryBright\}>\{`v\$\{item\.version\}`\}/, '版本必须使用主题亮主色');
assert.match(archExtensionsViewSource, /openExternalFile/);
assert.match(archExtensionsViewSource, /piPackageDetailsUrl/);
assert.doesNotMatch(archExtensionsViewSource, /ExtensionDetailModal|DetailPanel/, '扩展详情必须交给外部网址，不得实现 View 内弹窗');
assert.match(
	archExtensionsViewSource,
	/<box flexDirection="row" flexWrap="wrap" width="100%" flexGrow=\{1\}/,
	'扩展 Grid 行必须占满可用宽度'
);
assert.match(archExtensionsViewSource, /page=\{view\.query\.trim\(\) \? view\.page : undefined\}/, '已安装扩展列表不得传入分页信息');
assert.match(archExtensionsViewSource, /agentContext === 'pi'/);
assert.match(archExtensionsViewSource, /当前没有可管理的扩展/);
assert.match(archExtensionsViewSource, /onBusyStateChange/);
assert.match(archExtensionsViewSource, /taskCancellation\.start\(\)/, '扩展命令执行必须进入共享 busy overlay 生命周期');
assert.match(archExtensionsViewSource, /message: extensionCommand\(action\)/, '执行遮罩必须展示当前命令');
assert.match(archExtensionsViewSource, /view\.pendingAction && !view\.mutating/, '确认弹窗与执行遮罩必须分离');
assert.match(archExtensionsViewSource, /即将执行 \$\{command\}/, '确认弹窗只提示即将执行的 Pi 命令');
assert.match(archExtensionsViewSource, /`pi remove \$\{source\}`/, '卸载命令预览必须保留 Pi package source 前缀');
assert.match(
	archExtensionsConfirmSource,
	/<text fg=\{colors\.text\} selectionBg=\{colors\.selectionBg\} selectionFg=\{colors\.selectionFg\}>/,
	'卸载确认文本的选中前景/背景色必须跟随主题'
);
assert.doesNotMatch(archExtensionsConfirmSource, /colors\.warning/, '确认弹窗不再展示额外风险文案');
assert.doesNotMatch(archExtensionsViewSource, /扩展可运行代码|不会删除 ~\/\.pi\/agent/, '确认弹窗不得继续展示额外说明');
assert.doesNotMatch(archExtensionsViewSource, /ErrorPanel/, '扩展页不得把底层错误原文打印到底部');
assert.match(archExtensionsViewSource, /console\.error/, '扩展底层诊断必须写入控制台');
assert.match(
	archExtensionsCardSource,
	/const focusedBackground = focused \? colors\.focusedBackground : undefined;/,
	'Card 聚焦背景必须来自主题'
);
assert.ok((archExtensionsCardSource.match(/backgroundColor=\{focusedBackground\}/g) ?? []).length >= 4, 'Card 聚焦背景必须覆盖内容子节点');
assert.doesNotMatch(archExtensionsViewSource, /fixedPiMcpAdapterPackage|withFixedAdapter/);
assert.match(archExtensionsAppSource, /const piOnlyModule = displayMenuId === 'extensions'/);
assert.match(archExtensionsAppSource, /const moduleAgentContext: AgentContext = piOnlyModule \? 'pi' : state\.agentContext/);
assert.match(
	archExtensionsAppSource,
	/const visibleHeaderContexts: readonly AgentContext\[\] = piOnlyModule \? \['pi'\] : AGENT_CONTEXT_ORDER/
);
assert.match(archExtensionsAppSource, /<AgentHeader agentContext=\{moduleAgentContext\} contexts=\{visibleHeaderContexts\}/);
assert.match(archExtensionsAppSource, /<ModuleContent[\s\S]*agentContext=\{moduleAgentContext\}/);
assert.match(archExtensionsAppSource, /<ExtensionsView[\s\S]*agentContext=\{agentContext\}/);
assert.match(
	archExtensionsAppSource,
	/case 'extensions'[\s\S]*onBusyStateChange=\{onBusyStateChange\}/,
	'扩展执行必须接入全局 busy overlay'
);
assert.match(archExtensionsAppSource, /variant="overlay"/, '命令执行必须复用带 mask 的 Spinner overlay');
assert.doesNotMatch(archExtensionsAppSource, /<ExtensionsView[\s\S]*onExitToHeader/);
assert.match(archExtensionsShortcutsSource, /EXTENSIONS_COMMANDS\.OPEN_DETAILS, label: '查看详情'/);
assert.match(archExtensionsShortcutsSource, /EXTENSIONS_COMMANDS\.UPDATE_ALL, label: '全部更新'/);

// ── 迁自 verify-shortcuts.mjs（provider 表单 / 单一 registry 静态合同）────────
assert.doesNotMatch(archProviderFormSource, /Ctrl\+D|Space 多选|Ctrl\/Cmd\+S/, 'ProviderFormView 不应自行硬编码 Pi 快捷键提示');
assert.match(archProviderFormSource, /piModelDiscovery \? \(/, 'Pi 多选模型列表必须与 CC/CX 单选字段共存');
assert.doesNotMatch(archProviderFormSource, /setDiscovery\(null\)/, 'Esc 不得通过清空 discovery 隐藏模型列表');
assert.doesNotMatch(
	archProviderFormSource,
	/ProviderModelDiscoveryModal|<Modal active title="模型列表"/,
	'Provider 表单不应再渲染模型列表弹窗'
);
assert.match(archPiSelectionPanelSource, /MODEL_DISCOVERY_LIST_HEIGHT/, '内嵌模型列表必须受控滚动，避免撑出表单视口');
assert.match(archProviderFormSource, /toast\.warning\('请先填写 Base URL，再获取上游模型'\)/, 'Base URL 为空时必须用 toast 提示先填写地址');
assert.doesNotMatch(archProviderFormSource, /toast\.info\('正在获取上游模型…'\)/, 'Ctrl+D 开始获取时不应弹 toast');
assert.match(
	archProviderFormSource,
	/toast\.success\(`已获取 \$\{candidates\.length\} 个上游模型`\)/,
	'Ctrl+D 成功后必须给出可感知的成功反馈'
);
assert.match(archPiSelectionPanelSource, /<ListLoadingState message="正在获取上游模型"\s*\/>/, 'Ctrl+D 加载期间必须保留列表加载状态');
assert.match(archProviderFormSource, /toast\.error\(reason \|\| '模型发现失败'\)/, 'Ctrl+D 失败后必须直接展示上游错误 toast');
assert.match(archProviderFormSource, /onKeyEvent=\{handleFormKey\}/, 'Ctrl+D 必须由表单控件在任意字段焦点下接收');
assert.match(
	archProviderFormSource,
	/if \(onDiscover && matchesProviderCommand\(keyEvent, PROVIDER_COMMANDS\.FORM_DISCOVER\)\)/,
	'Ctrl+D 必须由页面级监听覆盖 textarea 与模型输入焦点'
);
assert.match(archProviderFormSource, /modelFocus|moveModelCursor/, '模型列表与自定义模型输入必须支持上下切换焦点');
assert.match(archProviderFormSource, /piSelectionForSubmit/, 'Ctrl+S 提交时必须携带已解析的模型定义快照');
assert.match(
	archProviderFormSource,
	/onApplyDiscovered\(parsed\.values, selectedModels\)/,
	'Ctrl+S 必须把已解析模型集合交给 adapter 写回草稿'
);
assert.match(
	archProviderFormSource,
	/filterModelCandidates[\s\S]*candidates\.filter\(candidate => candidate\.toLowerCase\(\)\.includes\(normalizedQuery\)\)/s,
	'手工模型输入必须按输入内容自动过滤候选模型'
);
assert.doesNotMatch(
	archProviderFormSource,
	/if \(modelFocus === 'manual'\) \{\s*const name = keyEvent\.name\.toLowerCase\(\);\s*if \(name === 'enter' \|\| name === 'return'\)/s,
	'手工模型输入的 Enter 不应由页面级监听重复处理'
);
assert.doesNotMatch(archProviderFormSource, /FORM_ADD_CUSTOM_MODEL/, 'Pi Provider 不应再处理 A 添加自定义模型');
assert.doesNotMatch(archProviderFormSource, /FORM_DISCOVERY_CONFIRM|applyDiscovery|applyModelIds/, '模型列表不应再有 Enter 应用阶段');
assert.doesNotMatch(archFormPanelSource, /MultiSelectField|multi-select/, 'FormPanel 不应内置业务多选字段');
assert.match(archFormPanelSource, /field\.type === 'model-select'/, 'FormPanel 必须把模型字段渲染为特殊单选控件');
assert.match(
	archProviderFormSource,
	/singleModelSelect && onDiscover && matchesProviderCommand\(keyEvent, PROVIDER_COMMANDS\.FORM_DISCOVER\)/,
	'CC/CX Ctrl+D 必须在表单层全局处理'
);
assert.match(
	archProviderViewSource,
	/if \(screen\.kind === 'add' \|\| screen\.kind === 'edit'\) return;/,
	'ProviderView 不得覆盖 ProviderFormView 上报的 form-model/form-pi 子模式'
);
assert.doesNotMatch(
	archProviderFormSource.slice(archSingleModelKeyStart, archFormKeyStart),
	/FORM_DISCOVER/,
	'CC/CX 模型 input 不得私有处理 Ctrl+D'
);
assert.match(archFormPanelSource, /readonly custom\?: ReactNode/, '业务自定义字段应由父组件通过 custom slot 传入');
assert.match(archProviderFormSource, /custom=\{/, 'Provider 模型列表应通过 FormPanel custom slot 注入');
assert.match(archSkillsViewSource, /viewShortcuts\('skills', mode\)/, 'Skills Modal hint 应从统一快捷键解析器生成');
assert.match(archSkillsViewSource, /hint=\{skillsModalHint\('confirm-topology-change'\)\}/, '拓扑切换确认 Modal 应展示统一快捷键提示');
assert.match(
	archToolsInputSource,
	/normalized === 'enter' \|\| normalized === 'return'\) return \{kind: 'primary'\}/,
	'Tools input Enter 应解析为统一主操作意图'
);
assert.match(archToolsInputSource, /normalized === 'u'\) return \{kind: 'update-one'\}/, 'Tools input u 应只解析为管理型工具更新意图');
assert.match(archToolsViewSource, /case 'primary':\s*runPrimaryAction\(/, 'ToolsView 主操作意图必须调用统一分派');
assert.match(archToolsViewSource, /case 'update-one':\s*updateInjectableCurrent\(/, 'ToolsView 更新意图必须调用管理型工具更新入口');
assert.equal((archProviderFormSource.match(/void handleDiscover\(/g) ?? []).length, 0, '表单层和页面层不得重复直接调用模型发现');
assert.ok(archSingleModelKeyStart >= 0 && archFormKeyStart > archSingleModelKeyStart, '必须存在单选字段和表单级键盘处理器');

// Pi 模型列表行只由 Space 分派选择意图；Enter 在列表行是 no-op，来源面板仍保留 Enter 确认。
const archPiSourceKeySource = archProviderFormSource.slice(archPiSourceKeyStart, archModelFocusKeyStart);
const archModelFocusKeySource = archProviderFormSource.slice(archModelFocusKeyStart, archSingleModelSelectStart);
assert.ok(
	archPiSourceKeyStart >= 0 && archModelFocusKeyStart > archPiSourceKeyStart && archSingleModelSelectStart > archModelFocusKeyStart,
	'必须存在 Pi 来源面板与模型列表键盘处理器锚点'
);
assert.match(archPiSourceKeySource, /FORM_CONFIRM/, '二级来源面板必须保留 Enter 确认来源');
assert.doesNotMatch(archModelFocusKeySource, /FORM_CONFIRM/, 'Pi 模型列表行内不得再处理 Enter（FORM_CONFIRM 只属于二级来源面板）');
assert.match(
	archModelFocusKeySource,
	/handlePiSelectionIntent\(\s*focused\.id,\s*piSelectionRef\.current\.selected\.has\(focused\.id\)\s*\?\s*'toggle'\s*:\s*'confirm'\s*\)/,
	'Pi 模型列表行必须只用 Space 按勾选态分派 toggle/confirm 意图'
);
assert.match(
	archModelFocusKeySource,
	/PROVIDER_COMMANDS\.FORM_MULTI_SELECT_TOGGLE[\s\S]{0,260}handlePiSelectionIntent/,
	'Pi 模型列表行的选择意图必须由 Space（FORM_MULTI_SELECT_TOGGLE）触发'
);

// ── 视图源码不得硬编码快捷键提示（单一 registry 契约，迁自 verify-shortcuts.mjs）──
for (const file of [
	'views/config/ConfigView.tsx',
	'views/prompts/PromptsView.tsx',
	'components/managed-document/ManagedDocumentView.tsx',
	'components/managed-document/DocumentHomeView.tsx',
	'components/managed-document/DocumentFormView.tsx'
]) {
	assert.doesNotMatch(read(file), /按\s*a|Ctrl\+|Cmd\+|\[[A-Za-z]\]/, `${file} 不应硬编码快捷键提示`);
}

console.log('[PASS] P1-G1 静态合同：扩展域路由/输入接线、provider 表单发现与单一 registry 不变量');
// ═══════════════════════════════════════════════════════════════════════════
// P1-G1b 静态合同并入门禁（迁自 verify-layout-shell.mjs / verify-agent-context.mjs /
// verify-copy-feedback.mjs / verify-toast-debug-console.mjs）
// B 类：有 spec 背书、但无进程内行为等价物的静态不变量 / 跨层必经路径。
// 每条保留原语义与错误消息（消息写明破掉会怎样）。
// ═══════════════════════════════════════════════════════════════════════════

const archG1bAppSource = read('app.tsx');
const archG1bViewHeaderSource = read('components/view-header.tsx');
const archG1bDocumentFormSource = read('components/managed-document/DocumentFormView.tsx');
const archG1bSpinnerSource = read('components/spinner.tsx');
const archG1bExecSource = read('core/exec.ts');
const archG1bComponentsIndexSource = read('components/index.ts');
const archG1bToolsViewSource = read('views/tools/ToolsView.tsx');
const archG1bToolsActionsSource = read('views/tools/tools-view-actions.ts');
const archG1bToolsInputSource = read('views/tools/tools-view-input.ts');
const archG1bSkillsViewSource = read('views/skills/SkillsView.tsx');
const archG1bSkillsActionsSource = read('views/skills/skills-view-actions.ts');
const archG1bMcpHomeSource = read('views/mcp/McpHomeView.tsx');
const archG1bIndexSource = read('index.tsx');

// ── 迁自 verify-layout-shell.mjs（Header 宽度 / split 布局 / 全局 busy overlay）──
assert.match(
	archG1bAppSource,
	/<AgentHeader agentContext=\{moduleAgentContext\} contexts=\{visibleHeaderContexts\} active=\{headerActive\} \/>/,
	'AgentHeader 调用必须使用当前模块的 Header 投影，不得继续传 width={contentWidth}'
);
assert.doesNotMatch(
	archG1bAppSource,
	/function AgentHeader\([^)]*width[^)]*\)/,
	'AgentHeader props 不得再声明 width，避免 Header 宽度与 content 卡片估算不一致'
);
assert.match(archG1bAppSource, /function AgentHeader[\s\S]{0,260}width="100%"/, 'AgentHeader 内部应使用 width="100%" 铺满右侧内容栏');
assert.doesNotMatch(archG1bAppSource, /function AgentHeader[\s\S]{0,260}width=\{width\}/, 'AgentHeader 内部不得使用 width={width} 写死宽度');
assert.match(
	archG1bViewHeaderSource,
	/subtitle === undefined \? null : [\s\S]{0,120}<text fg=\{colors\.muted\}[^>]*selectionBg=\{colors\.selectionBg\}[^>]*selectionFg=\{colors\.selectionFg\}/,
	'所有页面标题副文案必须使用主题化文本选中背景/前景'
);
for (const [name, source] of [['ConfigView', archG1bDocumentFormSource]]) {
	assert.match(
		source,
		/<box(?=[^>]*key="recommend-panel")(?=[^>]*flexGrow=\{1\})(?=[^>]*flexBasis=\{0\})(?=[^>]*minWidth=\{0\})[^>]*>/,
		`${name} split 推荐列必须用 flexGrow={1} + flexBasis={0} + minWidth={0} 保持横向等分`
	);
	assert.match(
		source,
		/<box(?=[^>]*key="editor-panel")(?=[^>]*flexGrow=\{1\})(?=[^>]*flexBasis=\{0\})(?=[^>]*minWidth=\{0\})[^>]*>/,
		`${name} split 编辑列必须用 flexGrow={1} + flexBasis={0} + minWidth={0} 保持横向等分`
	);
	assert.match(
		source,
		/<box(?=[^>]*flexGrow=\{1\})(?=[^>]*minHeight=\{0\})[^>]*borderStyle="rounded"/,
		`${name} split 左列推荐边框必须带 flexGrow={1} + minHeight={0}，避免溢出内容挤掉标题 marginBottom 导致边框错位`
	);
	assert.match(
		source,
		/<ThemedScrollbox(?=[^>]*style=\{\{[^}]*flexGrow: 1)(?=[^>]*style=\{\{[^}]*minHeight: 0)[^>]*>/,
		`${name} split 左列推荐 ThemedScrollbox 必须带 minHeight: 0，让内容在分配空间内收缩而非撑大父容器`
	);
}
assert.match(archG1bSpinnerSource, /props\.variant === 'overlay'/, '共享 Spinner 必须同时支持 inline 与 overlay 模式');
assert.match(archG1bSpinnerSource, /position="absolute"[\s\S]*width="100%"[\s\S]*height="100%"[\s\S]*zIndex=\{200\}/, 'Spinner overlay 必须覆盖整个终端并高于普通 Modal');
assert.match(archG1bSpinnerSource, /backgroundColor=\{colors\.modalBackground\}[\s\S]{0,80}opacity=\{0\.72\}/, 'Spinner overlay 背景必须使用主题色与半透明度');
assert.match(archG1bAppSource, /const \[busyOverlay, setBusyOverlay\] = useState<BusyOverlayState \| null>\(null\)/, 'App 必须持有全局 busy 蒙层状态');
assert.match(archG1bAppSource, /ownsViewInput = busyOverlay !== null \|\| updateDialogOpen/, '全局 busy 蒙层显示时必须锁住底层输入');
assert.match(archG1bAppSource, /active=\{effectiveFocus === 'view' && busyOverlay === null && !updateDialogOpen\}/, '全局蒙层或更新 Modal 显示时必须让底层视图失活');
assert.match(archG1bAppSource, /<Spinner[\s\S]{0,180}variant="overlay"[\s\S]{0,180}label=\{busyOverlay\.title\}/, 'App 根节点必须复用 Spinner 的 overlay 模式');
assert.match(archG1bExecSource, /readonly instruction\?: string/, '结构化 progress 必须单独携带当前真实指令');
for (const [name, rootSource, actionSource] of [
	['ToolsView', archG1bToolsViewSource, archG1bToolsActionsSource],
	['SkillsView', archG1bSkillsViewSource, archG1bSkillsActionsSource]
]) {
	assert.match(rootSource, /onBusyStateChange\?\./, `${name} 必须把执行状态上报 App`);
	assert.doesNotMatch(`${rootSource}\n${actionSource}`, /<ProgressLog\b/, `${name} 不得继续在页面底部渲染执行日志`);
	assert.match(actionSource, /if \(event\.instruction\)[\s\S]{0,180}message: event\.instruction/, `${name} 的 overlay 只能投影外部组件上报的真实指令`);
}
assert.doesNotMatch(archG1bComponentsIndexSource, /ProgressLog|progress-log/, '共享组件出口不得继续导出旧 ProgressLog');

// ── 迁自 verify-agent-context.mjs（隐藏 Header 模块的上下文 / 焦点不变量）──
assert.match(
	archG1bAppSource,
	/AGENT_HEADER_HIDDEN_MODULES\s*=\s*new Set<ManageModuleId>\(\[\s*'tools',\s*'mcp',\s*'skills'\s*\]\)/,
	'AGENT_HEADER_HIDDEN_MODULES 含 tools + mcp + skills（共享双侧模块隐藏 Header）'
);
assert.match(archG1bAppSource, /hideAgentHeader\s*\?\s*null\s*:\s*\(?\s*<AgentHeader/, '隐藏 Header 模块（hideAgentHeader）不渲染 AgentHeader');
assert.match(
	archG1bAppSource,
	/AGENT_HEADER_HIDDEN_MODULES\.has\(displayMenuId\) && state\.focus === 'header'/,
	'隐藏 Header 模块残留 header 焦点应强制回 view（焦点机跳过 header）'
);
assert.doesNotMatch(archG1bAppSource, /<ToolsView[^>]*onExitToHeader=\{/, 'ToolsView 调用不得再传 onExitToHeader（Tools 无 Header，顶行 ↑ 停首项）');
assert.doesNotMatch(archG1bAppSource, /<McpView[^>]*onExitToHeader=\{/, 'McpView 调用不得再传 onExitToHeader（MCP 无 Header，列表内循环）');
assert.doesNotMatch(archG1bAppSource, /<SkillsView[^>]*onExitToHeader=\{/, 'SkillsView 调用不得再传 onExitToHeader（Skills 无 Header，列表内循环）');
assert.doesNotMatch(
	archG1bAppSource,
	/createSkillsViewServices\(state\.agentContext\)/,
	'skillsViewServices 不得再按 state.agentContext 建 service key（检测与 agentContext 解耦）'
);
assert.doesNotMatch(archG1bToolsInputSource, /onExitToHeader/, 'ToolsView 不得引用 onExitToHeader（顶行 ↑ 停首项，不进 header）');
assert.doesNotMatch(archG1bMcpHomeSource, /onExitToHeader/, 'McpHomeView 不得引用 onExitToHeader（列表内循环，不进 header）');
assert.doesNotMatch(archG1bSkillsViewSource, /onExitToHeader/, 'SkillsView 不得引用 onExitToHeader（列表内循环，不进 header）');

// ── 迁自 verify-copy-feedback.mjs（copy-on-select 必经统一入口）──
assert.match(
	archG1bIndexSource,
	/copyTextWithFeedback\(renderer, selection\.getSelectedText\(\)\)/,
	'copy-on-select 必须经 copyTextWithFeedback 统一入口'
);

// ── 迁自 verify-toast-debug-console.mjs（自实现 toast 边界 + 调试控制台 env/按键）──
// 全源码扫描 import 语句（注释里保留「为什么自实现」的说明是允许的，只禁真实依赖）。
const archG1bRepoFiles = execFileSync('git', ['ls-files', 'src', 'scripts', 'tests'], {cwd: new URL('..', import.meta.url), encoding: 'utf8'})
	.split('\n')
	.filter(file => /\.(ts|tsx|mjs)$/.test(file));
for (const file of archG1bRepoFiles) {
	if (!existsSync(new URL(`../${file}`, import.meta.url))) continue;
	assert.doesNotMatch(
		readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
		/from ['"]@opentui-ui\/toast['"]/,
		`${file} 不得再从 @opentui-ui/toast import（该包与 @opentui/core 0.4.5 不兼容）`
	);
}
assert.match(archG1bIndexSource, /process\.env\.CCQ_DEBUG === '1'/, '调试控制台必须由 CCQ_DEBUG 环境变量驱动');
assert.match(archG1bIndexSource, /renderer\.console\.show\(\)/, 'CCQ_DEBUG=1 时必须展开 TerminalConsole 覆盖层');
assert.match(archG1bIndexSource, /renderer\.console\.toggle\(\)/, '必须提供快捷键切换控制台显隐');
assert.doesNotMatch(archG1bIndexSource, /key\.name === 'f\d+'/, '控制台快捷键不得用 F-key（macOS 上被系统占用且终端常不转发）');
assert.match(archG1bIndexSource, /isAppModifier\(key\)/, '控制台快捷键必须走 isAppModifier（复用项目 ctrl+<key> 平台约定）');

console.log(
	'[PASS] P1-G1b 静态合同：Header 投影/宽度、split 布局、busy overlay 必经路径、隐藏 Header 焦点、复制统一入口、toast 边界与调试控制台开关'
);

// ════════════════════════════════════════════════════════════════════════════
// P1-G2 静态合同并入门禁（迁自 verify-config-view.mjs / verify-prompts-view.mjs /
// verify-provider-tui.mjs / verify-provider-safety.mjs）
// 仅追加，不重排、不删除 P1-G1 / P1-G1b 段。
// ════════════════════════════════════════════════════════════════════════════

const archG2ConfigViewSource = [
	read('views/config/ConfigView.tsx'),
	read('views/config/config-document-adapter.ts'),
	read('components/managed-document/ManagedDocumentView.tsx'),
	read('components/managed-document/DocumentHomeView.tsx'),
	read('components/managed-document/DocumentFormView.tsx')
].join('\n');
const archG2PromptsViewSource = [read('views/prompts/PromptsView.tsx'), read('views/prompts/prompts-document-adapter.ts')].join('\n');
const archG2PromptsCoreSource = read('core/prompts.ts');
const archG2ProviderViewSource = read('views/provider/ProviderView.tsx');
const archG2ProviderHomeSource = read('views/provider/ProviderHomeView.tsx');
const archG2ProviderFormSource = read('views/provider/ProviderFormView.tsx');
const archG2FormLabelSource = read('components/form/FormLabel.tsx');
const archG2TextFieldSource = read('components/form/TextField.tsx');
const archG2RadioFieldSource = read('components/form/RadioField.tsx');
const archG2SelectFieldSource = read('components/form/SelectField.tsx');
const archG2KeyValueFieldSource = read('components/form/KeyValueField.tsx');
const archG2ModelSelectFieldSource = read('components/form/ModelSelectField.tsx');
const archG2CodexUserSurfaceSource = [
	'core/codex-provider-form.ts',
	'core/codex.ts',
	'services/codex-service.ts',
	'views/provider/ProviderView.tsx',
	'views/provider/ProviderHomeView.tsx',
	'views/provider/ProviderFormView.tsx',
	'cli/help.ts',
	'cli/index.ts',
	'cli/commands/ls.ts',
	'cli/commands/use.ts'
]
	.map(file => read(file))
	.join('\n');

// ── 迁自 verify-config-view.mjs（ConfigView → adapter 必经路径 / dirty 编辑 / editor 面板结构）──
assert.match(archG2ConfigViewSource, /createConfigDocumentAdapter\(props\.agentContext\)/, 'ConfigView 必须从 agentContext 派生 adapter');
assert.match(archG2ConfigViewSource, /if \(dirty\) \{[\s\S]{0,80}toast\.info\('已放弃未保存的编辑'\)/, '取消编辑必须识别 dirty 状态');
assert.match(
	archG2ConfigViewSource,
	/useEffect\(\(\) => \{[\s\S]{0,120}reset\(adapter\.load\(\)\);[\s\S]{0,40}\}, \[adapter\]\);/,
	'agentContext adapter 切换时必须重载视图状态，避免旧配置页内容残留'
);
assert.match(archG2ConfigViewSource, /setDirty\(false\);/, '保存/取消/切换后必须清理 dirty 状态，避免跨上下文误写');
// HC-EDITOR-PANEL-STABLE：editor 面板容器父路径必须恒定（始终 row 容器内的 key='editor-panel'），
// 推荐边栏作为带 key 的兄弟条件插入/移除。否则 split↔editor 切换会改变 editorEl 父路径，React 卸载重挂
// TextareaEditor，<textarea initialValue> 用 editInitial 重新初始化、丢失用户编辑（关闭推荐边栏内容回退 bug）。
assert.match(archG2ConfigViewSource, /key="editor-panel"/, 'ConfigView editor 面板必须有稳定 key，父路径恒定避免 textarea 重挂丢内容');
assert.match(archG2ConfigViewSource, /key="recommend-panel"/, 'ConfigView 推荐边栏必须作为带 key 的兄弟节点条件渲染，不改变 editor 面板父路径');
assert.doesNotMatch(
	archG2ConfigViewSource,
	/\?\s*\([\s\S]{0,200}\{editorEl\}[\s\S]{0,200}\)\s*:\s*\(\s*editorEl\s*\)/,
	'editor 不得再走 split/非 split 两分支渲染（会改变父路径导致重挂）'
);

// ── 迁自 verify-prompts-view.mjs（PromptsView → adapter 必经路径 / 规则 core 无推荐模板）──
assert.match(archG2PromptsViewSource, /createPromptsDocumentAdapter\(props\.agentContext\)/, 'PromptsView 必须从 agentContext 派生 adapter');
assert.doesNotMatch(archG2PromptsCoreSource, /recommendation|推荐|loadTextContract/i, '规则 core 不得加载推荐模板');

// ── 迁自 verify-provider-tui.mjs（Provider 视图 agentContext 接线 / Codex official / Pi 卡片 / 主题化选中色）──
assert.match(archG2ProviderViewSource, /agentContext:\s*AgentContext/, 'ProviderView props 必须接收 agentContext');
assert.match(archG2ProviderViewSource, /createProviderViewAdapter\(agentContext\)/, 'ProviderView 必须由 agentContext 构造领域 adapter');
assert.match(
	archG2ProviderViewSource,
	/setScreen\(\{kind: 'list'\}\);\r?\n\t\}, \[adapter\]\);/,
	'切换 agentContext 时必须重置列表屏，避免表单脏状态写入错误目标'
);
assert.match(archG2ProviderViewSource, /adapter=\{codexProviderFormAdapter\}/, 'Codex Provider 表单必须保留真实 TOML textarea adapter');
assert.match(archG2ProviderViewSource, /save=\{saveCodexProviderForm\}/, 'Codex Provider 新增必须走 Codex service/core，不得复用 Claude provider');
assert.match(
	archG2ProviderViewSource,
	/currentIsOfficial[\s\S]*不可在表单中编辑|不可在表单中编辑[\s\S]*currentIsOfficial/,
	'Codex official 必须在视图层阻止编辑'
);
assert.match(archG2ProviderViewSource, /Codex 官方账号.*codex logout/, 'Codex official 操作必须指向 Codex 原生 logout');
assert.match(archG2ProviderViewSource, /switchEnabled=\{adapter\.switchActive !== undefined\}/, 'ProviderView 必须按 adapter 能力启用切换');
assert.match(archG2ProviderHomeSource, /if \(hasCurrent && switchEnabled\) onSwitch\(\)/, 'Pi 列表 Enter 不得触发切换 action');
assert.match(
	archG2ProviderHomeSource,
	/leading: isPi \? undefined : row\.isActive \?/,
	'Pi 供应商列表卡片不得渲染状态圆点；Claude/Codex 保持活跃标记'
);
assert.match(
	archG2FormLabelSource,
	/fg=\{focused \? colors\.primary : colors\.muted\}[\s\S]{0,120}selectionBg=\{colors\.selectionBg\}[\s\S]{0,80}selectionFg=\{colors\.selectionFg\}/,
	'供应商表单 label 必须使用主题化文本选中背景/前景'
);
for (const [name, source] of [
	['TextField', archG2TextFieldSource],
	['RadioField', archG2RadioFieldSource],
	['SelectField', archG2SelectFieldSource],
	['KeyValueField', archG2KeyValueFieldSource]
]) {
	assert.match(
		source,
		/<text(?=[^>]*\bfg=\{colors\.muted\})(?=[^>]*\battributes=\{TextAttributes\.DIM\})(?=[^>]*\bselectionBg=\{colors\.selectionBg\})(?=[^>]*\bselectionFg=\{colors\.selectionFg\})[^>]*>/,
		`${name} help 文案必须使用主题化文本选中背景/前景`
	);
}
assert.match(
	archG2ModelSelectFieldSource,
	/attributes=\{TextAttributes\.DIM\}[\s\S]*selectionBg=\{colors\.selectionBg\}[\s\S]*selectionFg=\{colors\.selectionFg\}/,
	'ModelSelectField help 文案必须使用主题化文本选中背景/前景'
);
assert.match(
	archG2RadioFieldSource,
	/fg=\{selected \? colors\.navSelectedForeground : focused \? colors\.primary : colors\.text\}[\s\S]{0,120}selectionBg=\{colors\.selectionBg\}[\s\S]{0,80}selectionFg=\{colors\.selectionFg\}/,
	'供应商表单 radio 选项必须使用主题化文本选中背景/前景'
);
assert.match(
	archG2TextFieldSource,
	/fg=\{value \? colors\.text : colors\.muted\}[\s\S]{0,120}selectionBg=\{colors\.selectionBg\}[\s\S]{0,80}selectionFg=\{colors\.selectionFg\}/,
	'供应商表单 input 失焦值必须使用主题化文本选中背景/前景'
);
assert.match(
	archG2ProviderHomeSource,
	/body:\s*\(\s*<text(?=[^>]*\bfg=\{colors\.muted\})(?=[^>]*\bselectionBg=\{colors\.selectionBg\})(?=[^>]*\bselectionFg=\{colors\.selectionFg\})[^>]*>\s*\{row\.summary\}\s*<\/text>\s*\)/,
	'供应商列表卡片描述必须使用主题化文本选中背景/前景'
);

// ── 迁自 verify-provider-safety.mjs（视图内反馈通道 + Codex 用户可见文案）──
assert.match(archG2ProviderViewSource, /if \(warning\) \{\s*toast\.warning\(warning\);/, 'ProviderView 必须展示 partial-success warning');
assert.match(archG2ProviderHomeSource, /loadFailures\.length > 0[\s\S]*<ErrorPanel/, 'ProviderHomeView 必须展示 Codex profile 加载失败');
assert.match(archG2ProviderFormSource, /errorKind === 'conflict'[\s\S]*toast\.error\(result\.error\)/, 'ProviderForm 必须用 error toast 展示同名冲突');
assert.doesNotMatch(
	archG2CodexUserSurfaceSource,
	/['"`][^'"`\r\n]*Codex (?:profiles?|providers?|供应商)[^'"`\r\n]*['"`]/,
	'Codex 用户可见字符串必须直接使用供应商，不得添加 Codex 前缀或使用 profile/provider'
);
assert.match(archG2CodexUserSurfaceSource, /['"`][^'"`\r\n]*供应商[^'"`\r\n]*['"`]/, 'Codex 用户界面必须直接展示供应商术语');
assert.match(archG2CodexUserSurfaceSource, /codex --profile/, 'Codex 官方 --profile 技术参数必须保留');

console.log(
	'[PASS] P1-G2 静态合同：Config/Prompts adapter 必经路径、dirty 编辑与 editor 面板结构、Provider agentContext 接线、Codex official/Pi 卡片/主题化选中色、Codex 用户文案'
);

// P1-G3 静态合同并入门禁（迁自 verify-skills-render.mjs / verify-skills-view.mjs /
// verify-tools-manage.mjs / verify-tools-shared-projection.mjs /
// verify-skills-instance-state.mjs / verify-skills-update-action.mjs）。
// 仅追加，不重排、不删除 P1-G1 / P1-G1b / P1-G2 段。
const archG3SkillsViewSource = [
	read('views/skills/SkillsView.tsx'),
	read('views/skills/SkillsHomeView.tsx'),
	read('views/skills/SkillsInstallView.tsx'),
	read('views/skills/SkillsModals.tsx')
].join('\n');
const archG3CheckboxSource = read('components/checkbox.tsx');
const archG3CardSource = read('components/card.tsx');
const archG3ToolsHomeSource = read('views/tools/ToolsHomeView.tsx');
const archG3ToolsViewSource = read('views/tools/ToolsView.tsx');
const archG3ToolsServicesSource = read('views/tools/tools-view-services.ts');
const archG3UpdateSource = read('core/update.ts');
const archG3ViewDetectionSource = read('services/view-detection.ts');
const archG3ToolsManageSource = read('core/tools-manage.ts');
const archG3SkillsStateSource = read('state/skills-view-state.ts');
const archG3SkillsActionsSource = read('views/skills/skills-view-actions.ts');
const archG3SkillsServiceSource = read('services/skills-service.ts');

// ── 迁自 verify-skills-render.mjs / verify-skills-view.mjs（Skills 视图结构与共享组件所有权）──
assert.match(archG3SkillsViewSource, /<ScrollList items=\{items\}/, 'Skills 已安装页必须是单列 ScrollList；破坏后分组/条目失去共享滚动与焦点所有权');
assert.match(archG3SkillsViewSource, /focusIndicator="card"/, 'Skills 条目聚焦态必须复用 Card 的边框与背景；破坏后聚焦态不再有语义 active border');
assert.match(
	archG3SkillsViewSource,
	/<RadioField[\s\S]*label="布局："[\s\S]*value=\{view\.homeLayout\}[\s\S]*compact/,
	'布局摘要必须复用紧凑 RadioField 展示平铺/分组；破坏后页面级 layout 摘要与 selection 所有权分离'
);
assert.match(
	archG3SkillsViewSource,
	/<a href=\{url\} fg=\{colors\.muted\} attributes=\{TextAttributes\.DIM \| TextAttributes\.UNDERLINE\}>/,
	'已安装 sourceUrl 颜色必须与安装页 muted + DIM 一致；破坏后链接脱离 source 样式契约'
);
assert.match(archG3SkillsViewSource, /bordered: false/, '分组标题必须声明为无边框行；破坏后轻量 structural row 被当成 domain Card');
assert.match(
	archG3SkillsViewSource,
	/titleColor: active && index === view\.resultIndex \? colors\.primary : colors\.text/,
	'Skills 安装页 active 标题必须使用主题色，非 active 标题使用正常文字色；破坏后禁用/冲突行错误高亮'
);
assert.doesNotMatch(
	archG3SkillsViewSource,
	/titleColor: detectionReady && item\.selectable \? colors\.primary : colors\.muted/,
	'非 active 与不可选标题不得使用主题色或 muted 色；破坏后 waited/disabled 状态被误标为主色'
);
assert.match(
	archG3CardSource,
	/<box(?=[^>]*flexDirection="row")(?=[^>]*flexShrink=\{0\})(?=[^>]*width=\{3\})(?=[^>]*height=\{1\})(?=[^>]*justifyContent="center")(?=[^>]*marginRight=\{1\})[^>]*>/,
	'Card leading 标记必须固定在标题首行顶对齐；破坏后 Skills 状态与下载量在窄布局被挤出'
);
assert.match(
	archG3CardSource,
	/if \(leading !== undefined\)[\s\S]*?titleRight === undefined[\s\S]*?\/\/ 纵向布局/,
	'Card leading 布局必须渲染 titleRight，确保 Skills 状态与下载量可见；破坏后 status/download 事实丢失'
);
// 两个布局分支的根节点同为 <box>，React 会跨分支复用 host node，而渲染器不清除已移除的布局属性：
// 纵向分支的 body 节点带 height={1}，切回横向分支后该节点变成内容列并被压成 1 行，卡片少一行（body 行
// 被裁掉）；反向切换时 leading 盒的 width={3} 残留并截断标题。互斥 key 强制 remount 是这两条路径的唯一防线。
assert.match(archG3CardSource, /key="card-horizontal"/, 'Card 横向分支根节点必须带互斥 key；删除后切回列表时 body 行被旧 height 裁掉');
assert.match(archG3CardSource, /key="card-vertical"/, 'Card 纵向分支根节点必须带互斥 key；删除后切回列表时标题被旧 width 裁断');
assert.match(archG3SkillsViewSource, /item\.installed\.id/, '同一新来源对应多个旧实例时 Modal key 必须区分旧实例；破坏后覆盖确认行错位/复用');
assert.match(archG3ToolsHomeSource, /<ListLoadingState message="检测中\.\.\." \/>/, 'ToolsView 应使用共享全局 loading；破坏后各视图 loading 布局与文案分叉');
assert.match(archG3SkillsViewSource, /<ListLoadingState message="检测中\.\.\." \/>/, 'SkillsView 应复用 ToolsView 的共享全局 loading；破坏后检测布局与文案分叉');
assert.doesNotMatch(archG3CheckboxSource, /TextAttributes\.INVERSE/, 'Checkbox active/checked 应使用主题前景色，不得反转为背景色；破坏后 checkbox 脱离语义主题');

// ── 迁自 verify-tools-manage.mjs / verify-tools-shared-projection.mjs（registry 单一真理源与缓存绕行）──
assert.match(
	archG3UpdateSource,
	/NPM_COMPONENT_MAP[^\n]*=\s*Object\.fromEntries\(\s*\n?\s*TOOL_DEFINITIONS\.filter\(def => def\.npmPackage\)/,
	'update.ts NPM_COMPONENT_MAP 派生自 registry 的 npmPackage；破坏后 npm 映射与 registry 漂移'
);
assert.match(
	archG3UpdateSource,
	/COMMAND_COMPONENTS[^\n]*=\s*Object\.fromEntries\(\s*TOOL_DEFINITIONS\.map\(def => \[\s*def\.id,\s*\{\s*command: def\.command,\s*versionArgs: \[\.\.\.def\.versionArgs\]/,
	'update.ts COMMAND_COMPONENTS 派生自 registry 的 command/versionArgs；破坏后检测命令与 registry 漂移'
);
assert.match(
	archG3ToolsServicesSource,
	/refreshDetection:\s*\(runner,\s*options\)\s*=>\s*runToolsDetection\(runner,\s*options\)/,
	'Tools service 为手动刷新提供专用 refreshDetection；破坏后手动刷新丢失 forceRefresh 通道'
);
assert.match(
	archG3ViewDetectionSource,
	/detectComponents\(undefined,\s*options\.forceRefresh === true\)/,
	'runToolsDetection 透传 forceRefresh；破坏后手动刷新仍读旧 npm 缓存'
);
assert.match(archG3ToolsManageSource, /getNpmOutdatedGlobal\(forceRefresh\)/, 'detectComponents 强刷 npm outdated 缓存；破坏后 latest 卡在旧缓存');
assert.match(
	archG3UpdateSource,
	/resolveNpmViewLatest\(Object\.values\(NPM_COMPONENT_MAP\),\s*forceRefresh\)/,
	'checkCliToolUpdates 强刷 npm view 缓存；破坏后 latest 卡在旧缓存'
);
assert.doesNotMatch(archG3ToolsHomeSource, /label:\s*['"]Agent['"]/, 'ToolsHomeView 不硬编码 Agent 分组 label；破坏后分组文案脱离单一 registry');
assert.match(
	archG3ToolsViewSource,
	/<ToolsHomeView[\s\S]{0,180}active=\{active && view\.mode === 'grid'\}/,
	'Tools Modal 打开时背景网格必须失焦；破坏后 Modal 输入会穿透到网格'
);

// ── 迁自 verify-skills-instance-state.mjs / verify-skills-update-action.mjs（已废弃 seam 不得回归）──
assert.doesNotMatch(archG3SkillsStateSource, /action-uninstall-done/, '不得恢复 name 级乐观删除 action；破坏后最终 state 会被本地过滤冒充');
assert.doesNotMatch(archG3SkillsStateSource, /storage\?\.kind/, 'reducer 不得再依赖物理 storage 分类；破坏后 filesystem inspection 成为 identity oracle');
assert.doesNotMatch(archG3SkillsStateSource, /topologyOfInspection/, 'reducer 不得再由物理 inspection 推导拓扑；破坏后 UI state 脱离 CLI 事实');
assert.doesNotMatch(
	archG3SkillsActionsSource,
	/runUpdateIfReadyAction|runUpdateOneIfReadyAction/,
	'TUI 不得保留全量/旧单项 update 入口；破坏后批量 update 退化为多次 CLI 调用'
);
assert.doesNotMatch(archG3SkillsServiceSource, /updateAllSkillsBothSides/, 'view service 不得保留更新全部 seam；破坏后批量 update 空名单会误走「更新全部」');

console.log(
	'[PASS] P1-G3 静态合同：Skills 视图结构与共享组件所有权、registry 单一真理源与手动刷新绕行、已废弃 seam 不得回归'
);

// ── 迁自 verify-gitnexus-lifecycle.mjs（CLI/TUI 共用 core 入口，不得层外特判）──
const archG4CliToolsSource = read('cli/commands/tools.ts');
assert.match(
	archG4CliToolsSource,
	/uninstallComponent[\s\S]{0,200}from '\.\.\/\.\.\/core\/tools-manage\.js'/,
	'CLI 卸载必须走 core/tools-manage 的 uninstallComponent；破坏后命令序列会在 CLI 层复制一份'
);
assert.doesNotMatch(
	archG4CliToolsSource,
	/gitnexus/i,
	'CLI 层不得出现 GitNexus 特判；破坏后命令序列脱离 core 单一真理源'
);
const archG4ToolsServicesSource = read('views/tools/tools-view-services.ts');
assert.match(
	archG4ToolsServicesSource,
	/uninstallComponent\(id, onProgress/,
	'TUI service 必须调用 core uninstallComponent；破坏后两路卸载行为分叉'
);
assert.doesNotMatch(
	archG4ToolsServicesSource,
	/gitnexus/i,
	'TUI service 层不得出现 GitNexus 特判；破坏后共享工具投影失守'
);

console.log('[PASS] P1-G4 静态合同：工具卸载的 CLI/TUI 共用 core 入口、无层外特判');