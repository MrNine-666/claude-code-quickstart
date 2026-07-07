import type {KeyEvent} from '@opentui/core';

export type ShortcutPlatform = 'darwin' | 'default';

type KeyEventLike = Pick<KeyEvent, 'name'> & {
	readonly ctrl?: boolean;
	readonly meta?: boolean;
	readonly option?: boolean;
	readonly super?: boolean;
};

export function shortcutPlatform(): ShortcutPlatform {
	return process.platform === 'darwin' ? 'darwin' : 'default';
}

export function editingShortcutKey(keyName: string, platform: ShortcutPlatform = shortcutPlatform()): string {
	return `${platform === 'darwin' ? 'super' : 'ctrl'}+${keyName}`;
}

export function appShortcutKey(keyName: string): string {
	return `ctrl+${keyName}`;
}

export function isEditingModifier(keyEvent: KeyEventLike, platform: ShortcutPlatform = shortcutPlatform()): boolean {
	return platform === 'darwin' ? keyEvent.super === true : keyEvent.ctrl === true;
}

export function isAppModifier(keyEvent: KeyEventLike): boolean {
	return keyEvent.ctrl === true;
}

export function hasShortcutModifier(keyEvent: KeyEventLike): boolean {
	return keyEvent.ctrl === true || keyEvent.meta === true || keyEvent.option === true || keyEvent.super === true;
}

const KEY_NAME_ALIASES: Record<string, string> = {
	escape: 'Esc',
	enter: 'Enter',
	return: 'Enter',
	up: '↑',
	down: '↓',
	left: '←',
	right: '→',
	space: 'Space',
	tab: 'Tab'
};

const MAC_MODIFIER_SYMBOLS: Record<string, string> = {
	ctrl: '⌃',
	shift: '⇧',
	meta: '⌥',
	option: '⌥',
	super: '⌘',
	hyper: 'Hyper+'
};

const TEXT_MODIFIER_ALIASES: Record<string, string> = {
	ctrl: 'Ctrl',
	shift: 'Shift',
	meta: 'Alt',
	option: 'Alt',
	super: 'Super',
	hyper: 'Hyper'
};

export function formatShortcutKey(key: string, platform: ShortcutPlatform = shortcutPlatform()): string {
	return key
		.split('/')
		.map(variant => formatShortcutVariant(variant.trim(), platform))
		.filter(Boolean)
		.join('/');
}

function formatShortcutVariant(variant: string, platform: ShortcutPlatform): string {
	if (variant.length === 0) {
		return '';
	}

	return variant
		.split(/\s+/)
		.map(stroke => formatShortcutStroke(stroke, platform))
		.filter(Boolean)
		.join(' ');
}

function formatShortcutStroke(stroke: string, platform: ShortcutPlatform): string {
	const tokens = stroke.split('+').map(token => token.trim()).filter(Boolean);
	if (tokens.length === 0) {
		return stroke;
	}

	const keyName = tokens[tokens.length - 1]!;
	const modifiers = tokens.slice(0, -1);
	const formattedKey = formatKeyName(keyName);

	if (platform === 'darwin') {
		return `${modifiers.map(formatMacModifier).join('')}${formattedKey}`;
	}

	return [...modifiers.map(formatTextModifier), formattedKey].join('+');
}

function formatKeyName(name: string): string {
	const lower = name.toLowerCase();
	if (KEY_NAME_ALIASES[lower]) {
		return KEY_NAME_ALIASES[lower];
	}

	return /^[a-z]$/.test(name) ? name.toUpperCase() : name;
}

function formatMacModifier(modifier: string): string {
	return MAC_MODIFIER_SYMBOLS[modifier.toLowerCase()] ?? `${modifier}+`;
}

function formatTextModifier(modifier: string): string {
	return TEXT_MODIFIER_ALIASES[modifier.toLowerCase()] ?? modifier;
}
