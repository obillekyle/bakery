import { defineConfig } from '@server/core'

export default defineConfig({
  root: 'src',
  port: 3000,
  plugins: [],
  head: `<link rel="stylesheet" href="/styles/global.css">`,
  hosts: {
    'example.localhost': {
      root: 'src/example',
    },
  },
  body: '',
})
