// Form 字段类型定义（通用表单系统的类型契约）
// 基于 mcp-form / provider-form 现有用法归纳

/** Select 选项（下拉/切换选择器的单项） */
export type SelectOption = {
	readonly value: string;
	readonly label: string;
};

/** Key-Value 条目（环境变量等键值对编辑） */
export type KeyValueEntry = {
	readonly key: string;
	readonly value: string;
};

/** 表单字段（判别联合：5 种类型） */
export type FormField =
	| {
			readonly id: string;
			readonly type: 'readonly';
			readonly label: string;
			readonly value: string;
			readonly helpText?: string;
	  }
	| {
			readonly id: string;
			readonly type: 'text';
			readonly label: string;
			readonly value: string;
			readonly helpText?: string;
			readonly disabled?: boolean;
	  }
	| {
			readonly id: string;
			readonly type: 'secret';
			readonly label: string;
			readonly value: string;
			readonly helpText?: string;
			readonly disabled?: boolean;
	  }
	| {
			readonly id: string;
			readonly type: 'select';
			readonly label: string;
			readonly value: string;
			readonly options: readonly SelectOption[];
			readonly helpText?: string;
			readonly disabled?: boolean;
	  }
	| {
			readonly id: string;
			readonly type: 'radio';
			readonly label: string;
			readonly value: string;
			readonly options: readonly SelectOption[];
			readonly helpText?: string;
			readonly disabled?: boolean;
	  }
	| {
			readonly id: string;
			readonly type: 'key-value';
			readonly label: string;
			readonly entries: readonly KeyValueEntry[];
			readonly helpText?: string;
			readonly disabled?: boolean;
	  };
