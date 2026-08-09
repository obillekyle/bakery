import { defineConfig } from '@bakery-framework/core'
import dashboardPlugin from '@bakery-framework/plugin-dashboard'

export default defineConfig({
  root: 'src',
  port: 3000,
  plugins: [
    // The app decides who may use the console; the console does not ask.
    dashboardPlugin({ authorize: () => true }),
  ],
  head: `<link rel="stylesheet" href="/styles/global.css">`,
  hosts: {
    'example.localhost': {
      root: 'src/example',
    },
  },
  body: '',
})
