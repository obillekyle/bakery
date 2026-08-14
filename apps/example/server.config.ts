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
    // Both doors, so the example exercises both, and they are deliberately
    // not set to the same level — that is the whole point of the model.
    //
    // The predicate grants **read** to anyone, so opening `/_db` in a browser
    // shows the grid with no edit affordances. Writing needs the `ops` key.
    // A real app would ask its session here rather than waving everyone in.
    //
    // Note what `higher wins` means for a demo: an `authorize` returning
    // 'write' would override the read-only key and make the level split
    // untestable, because the two doors answer about the same caller.
    //
    // There is no default access any more. An explorer with neither `users`
    // nor `authorize` admits nobody, which is why this cannot be `{}`.
    dbExplorerPlugin({
      users: {
        ops: { credential: 'demo-db-key', access: 'write' },
        viewer: { credential: 'demo-db-readonly', access: 'read' },
      },
      authorize: () => 'read',
    }),
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
