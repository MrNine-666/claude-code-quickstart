import {TextAttributes} from '@opentui/core';
import type {ReactNode} from 'react';
import {SelectField, TextField, ViewHeader} from '../../components/index.js';
import type {SystemSettingsPageState} from '../../state/system-settings-state.js';
import {borderColors, colors} from '../../theme/index.js';

// 系统设置单页：自动更新、是否加密与密码输入；分类清单与多选只在弹窗展示。

export type SystemSettingsPageViewProps = {
	readonly state: SystemSettingsPageState;
	readonly active: boolean;
	/** App 持有的自动更新偏好（受控值）。 */
	readonly autoUpdate: boolean;
	readonly autoUpdateError: string | null;
	readonly onAutoUpdateChange: (value: boolean) => void;
	readonly onEncryptionChange: (value: boolean) => void;
	readonly onPasswordChange: (value: string) => void;
};

export function SystemSettingsPageView({
	state,
	active,
	autoUpdate,
	autoUpdateError,
	onAutoUpdateChange,
	onEncryptionChange,
	onPasswordChange
}: SystemSettingsPageViewProps) {
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<ViewHeader title="系统设置" subtitle="CCQ 自动更新与全局配置导入导出" />

			<SettingsSection
				marginTop={1}
				title="自动更新"
				status={autoUpdateError ? '设置受限' : autoUpdate ? '已开启' : '未开启'}
				statusColor={autoUpdateError ? colors.warning : autoUpdate ? colors.success : colors.muted}
				focused={active && state.focus === 'auto-update'}
			>
				<SelectField
					label="自动更新"
					value={autoUpdate ? 'yes' : 'no'}
					options={[
						{value: 'yes', label: '是'},
						{value: 'no', label: '否'}
					]}
					focused={active && state.focus === 'auto-update'}
					onChange={value => onAutoUpdateChange(value === 'yes')}
					helpText="开启后后台下载，正常退出时应用；关闭时仅检查更新"
				/>
				{autoUpdateError ? (
					<text fg={colors.warning} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} wrapMode="word">
						{`⚠ ${autoUpdateError}`}
					</text>
				) : null}
			</SettingsSection>

			<ImportExportSection
				state={state}
				active={active}
				onEncryptionChange={onEncryptionChange}
				onPasswordChange={onPasswordChange}
			/>
		</box>
	);
}

// 分区共用同一边框、焦点与主题布局。
function SettingsSection({
	title,
	status,
	statusColor,
	focused,
	marginTop = 0,
	grow = false,
	children
}: {
	readonly title: string;
	readonly status: string;
	readonly statusColor: string;
	readonly focused: boolean;
	readonly marginTop?: number;
	readonly grow?: boolean;
	readonly children: ReactNode;
}) {
	return (
		<box
			flexDirection="column"
			flexGrow={grow ? 1 : 0}
			flexShrink={grow ? 1 : 0}
			minHeight={0}
			marginTop={marginTop}
			paddingX={1}
			borderStyle="rounded"
			borderColor={focused ? borderColors.active : borderColors.inactive}
		>
			<box flexDirection="row" height={1} flexShrink={0} overflow="hidden">
				<text fg={focused ? colors.primary : colors.text} attributes={TextAttributes.BOLD} flexGrow={1}>
					{title}
				</text>
				<text fg={statusColor} flexShrink={0}>
					{status}
				</text>
			</box>
			{children}
		</box>
	);
}

function ImportExportSection({
	state,
	active,
	onEncryptionChange,
	onPasswordChange
}: Pick<SystemSettingsPageViewProps, 'state' | 'active' | 'onEncryptionChange' | 'onPasswordChange'>) {
	const encrypted = state.encryption;
	return (
		<SettingsSection
			title="导入导出"
			status="选择分类"
			statusColor={colors.muted}
			focused={active && (state.focus === 'encryption' || state.focus === 'password')}
		>
			<box flexDirection="column" flexShrink={0}>
				<SelectField
					label="是否加密"
					value={encrypted ? 'yes' : 'no'}
					options={[
						{value: 'yes', label: '是'},
						{value: 'no', label: '否'}
					]}
					focused={active && state.focus === 'encryption'}
					onChange={value => onEncryptionChange(value === 'yes')}
					helpText={encrypted ? '用密码加密整个导出包' : undefined}
				/>
				{encrypted ? (
					<TextField
						label="导出密码"
						value={state.password}
						secret
						active={active}
						focused={active && state.focus === 'password'}
						onChange={onPasswordChange}
						helpText="保存后密码明文写入本机 JSON，不随备份包迁移"
					/>
				) : (
					<text fg={colors.warning} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} wrapMode="word">
						⚠ 明文包可能包含 API Key 和扩展源码中的密钥
					</text>
				)}
			</box>
		</SettingsSection>
	);
}
