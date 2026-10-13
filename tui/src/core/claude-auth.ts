import {resolve} from 'node:path';
import {execCommand, type ExecResult} from './exec.js';

export const CLAUDE_OAUTH_ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES'] as const;
export const CLAUDE_NATIVE_AUTH_GUIDANCE = '请运行 claude auth login / claude auth logout；状态可用 claude auth status 查看。';
export type ClaudeAuthStatus = {readonly status: 'configured' | 'missing' | 'unknown'; readonly reason?: string};
export type ClaudeAuthOptions = {readonly signal?: AbortSignal; readonly exec?: typeof execCommand};

export function stripClaudeOAuthEnv<T>(env: Readonly<Record<string, T>>): Record<string, T> {
	const next = {...env};
	for (const key of CLAUDE_OAUTH_ENV_KEYS) delete next[key];
	return next;
}

const overrideKeys = [
	'ANTHROPIC_BASE_URL',
	'ANTHROPIC_AUTH_TOKEN',
	'ANTHROPIC_API_KEY',
	...CLAUDE_OAUTH_ENV_KEYS,
	'CLAUDE_CODE_USE_BEDROCK',
	'CLAUDE_CODE_USE_VERTEX',
	'CLAUDE_CODE_USE_FOUNDRY'
];

export function claudeAuthBlocker(env: Readonly<Record<string, unknown>>): string | undefined {
	const keys = overrideKeys.filter(key => {
		const value = env[key];
		if (value === undefined || value === '') return false;
		return !key.startsWith('CLAUDE_CODE_USE_') || (value !== '0' && value !== 'false');
	});
	return keys.length ? `认证覆盖：${keys.join('、')}` : undefined;
}

function sameDirectory(a: string, b: string): boolean {
	const normalize = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
	return normalize(a) === normalize(b);
}

export function parseClaudeAuthStatus(result: ExecResult, directory: string, env: NodeJS.ProcessEnv = process.env): ClaudeAuthStatus {
	const unknown = (reason: string): ClaudeAuthStatus => ({status: 'unknown', reason});
	if (result.stdout.length > 65536 || result.stderr.length > 65536) return unknown('原生授权输出超限');
	let value: unknown;
	try {
		value = JSON.parse(result.stdout);
	} catch {
		return unknown('原生授权输出无法确认，请检查 Claude CLI 版本');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown('原生授权输出格式无法确认');
	const data = value as Record<string, unknown>;
	if (
		data.configDirectory !== undefined &&
		(typeof data.configDirectory !== 'string' || !sameDirectory(data.configDirectory, directory))
	) {
		return unknown('Claude 配置目录与 ccq 管辖目录不一致');
	}
	if (env.CLAUDE_CONFIG_DIR && !sameDirectory(env.CLAUDE_CONFIG_DIR, directory)) return unknown('CLAUDE_CONFIG_DIR 覆盖了 ccq 管辖目录');
	const blocker = claudeAuthBlocker(env);
	if (blocker) return unknown(blocker);
	if (data.authMethod === 'claude.ai' && result.code === 0 && (data.loggedIn === undefined || data.loggedIn === true))
		return {status: 'configured'};
	if (data.authMethod === 'none' && result.code === 1 && (data.loggedIn === undefined || data.loggedIn === false))
		return {status: 'missing'};
	return unknown('当前认证不是已确认的官方账号 OAuth，或原生状态不一致');
}

export async function readClaudeAuthStatus(directory: string, options: ClaudeAuthOptions = {}): Promise<ClaudeAuthStatus> {
	if (options.signal?.aborted) return {status: 'unknown', reason: '授权状态查询已取消'};
	try {
		const result = await (options.exec ?? execCommand)('claude', ['auth', 'status'], {timeout: 5000, signal: options.signal});
		if (options.signal?.aborted) return {status: 'unknown', reason: '授权状态查询已取消'};
		return parseClaudeAuthStatus(result, directory);
	} catch {
		return {
			status: 'unknown',
			reason: options.signal?.aborted ? '授权状态查询已取消' : '无法查询原生授权状态，请检查 Claude CLI 安装或版本'
		};
	}
}
