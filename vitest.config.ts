import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // cli is command wiring; exec/doctor are thin diagnostic shells exercised
      // for real by scripts/smoke.sh — excluded from unit thresholds
      exclude: ['src/cli.ts', 'src/adapters/exec.ts', 'src/doctor.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
