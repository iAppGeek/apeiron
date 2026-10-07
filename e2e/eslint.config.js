import config from '@apeiron/eslint-config';

export default [...config, { ignores: ['playwright-report/**', 'test-results/**'] }];
