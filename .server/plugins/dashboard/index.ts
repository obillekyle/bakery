import { definePlugin } from '@plugins/types'

export default function dashboardPlugin() {
  return definePlugin({
    name: 'dashboard',
    async setup() {
      const { setupDashboard } = await import('./setup')
      await setupDashboard()
    },
  })
}
