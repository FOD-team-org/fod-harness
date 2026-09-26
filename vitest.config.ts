import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { FODH_NOTIFY_OS: 'off' },
    testTimeout: 30_000,
  },
});
