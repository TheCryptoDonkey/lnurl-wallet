import {defineConfig} from 'vitest/config'
import solidPlugin from 'vite-plugin-solid'
import {gitVersion} from './scripts/git-version.mjs'

export default defineConfig({
  plugins: [solidPlugin()],
  // matches vite.config.ts's own define - nothing currently under test
  // reads __APP_VERSION__, but keeps it available if that changes
  define: {
    __APP_VERSION__: JSON.stringify(gitVersion('dev'))
  },
  test: {
    // Crypto/codec tests use Node's WebCrypto. UI regressions opt into
    // happy-dom per file so the actual wallet handlers and cards are tested.
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
