import {expect, test} from 'bun:test';
import {piSettingsPath} from '../../src/core/paths.js';
import {getConfigPath} from '../../src/services/config-service.js';

test('Pi Config 路径指向 ~/.pi/agent/settings.json', () => {
	expect(getConfigPath('pi')).toBe(piSettingsPath());
});
