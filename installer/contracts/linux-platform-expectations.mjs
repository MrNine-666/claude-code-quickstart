#!/usr/bin/env node
// linux-platform-expectations.mjs - 把 linux-platforms.json 展开为纯文本期望表
// 用法: node installer/contracts/linux-platform-expectations.mjs [linux-platforms.json] > expectations.tsv
// 容器内可能没有 node/jq，因此宿主（workflow step）先展开，再把文件传给 Test-LinuxInstaller.sh。
// 每行以 TAB 分隔；空字段写成 "-"（Bash 的 IFS=$'\t' 会合并连续 TAB）。
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const contractPath = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'linux-platforms.json');
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const field = value => (value === undefined || value === null || value === '' ? '-' : String(value));
const lines = [];

for (const sample of contract.ClassificationSamples) {
	const packageManager = sample.Family ? contract.Families[sample.Family].PackageManager : '';
	lines.push(['classify', sample.Id, sample.VersionId, sample.Name, sample.IdLike, sample.Class, sample.Family, packageManager].map(field));
}
for (const [name, manager] of Object.entries(contract.PackageManagers)) {
	for (const step of ['Update', 'InstallGit']) {
		if (manager[step]) lines.push(['argv', name, step, manager[step].join(' ')].map(field));
	}
	lines.push(['failure', name, manager.FailureStatus, manager.ManualHint].map(field));
}
for (const [arch, aliases] of Object.entries(contract.Architectures)) {
	for (const alias of aliases) lines.push(['arch', alias, arch].map(field));
}

process.stdout.write(lines.map(line => line.join('\t')).join('\n') + '\n');
