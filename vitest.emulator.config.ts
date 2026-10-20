import { defineConfig } from 'vitest/config';

// Runs inside `firebase emulators:exec`, which sets FIRESTORE_EMULATOR_HOST.
export default defineConfig({
  test: {
    include: ['test/**/*.emulator.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
