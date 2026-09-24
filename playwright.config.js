import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 1050 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: { args: ['--enable-webgl', '--enable-unsafe-swiftshader'] },
    screenshot: 'only-on-failure',
    // Continuous trace screenshots are costly with software WebGL. Capture
    // only on an explicitly requested retry; failures still save screenshots.
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});