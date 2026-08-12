import { defineConfig } from '@bakery-framework/core'
import dashboardPlugin from '@bakery-framework/plugin-dashboard'
import analyticsPlugin from '@bakery-framework/plugin-analytics'
import dbExplorerPlugin from '@bakery-framework/plugin-db-explorer'

export default defineConfig({
  root: 'src',
  port: 3000,
  plugins: [
    // The app decides who may use the console; the console does not ask.
    dashboardPlugin({ authorize: () => true }),
    // No authorize on purpose: the default (loopback-only in dev) is the
    // configuration most installs will run, so the example exercises it.
    dbExplorerPlugin(),
    analyticsPlugin({ credential: 'demo-analytics-key' }),
  ],
  head: `<link rel="stylesheet" href="/styles/global.css">`,
  hosts: {
    'example.localhost': {
      root: 'src/example',
    },
  },
  body: '',
})
