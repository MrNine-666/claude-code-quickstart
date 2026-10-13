import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export function createTempHome(prefix: string) {
	const path = mkdtempSync(join(tmpdir(), prefix));
	const temp = join(path, 'tmp');
	mkdirSync(temp);
	const overrides = {
		CCQ_HOME: path,
		HOME: path,
		USERPROFILE: path,
		CLAUDE_CONFIG_DIR: join(path, '.claude'),
		TEMP: temp,
		TMP: temp,
		TMPDIR: temp
	};
	const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
	Object.assign(process.env, overrides);
	return {
		path,
		restore() {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
		cleanup() {
			rmSync(path, {recursive: true, force: true});
		}
	};
}
