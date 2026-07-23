import { response } from '@server/core'

export default function handler() {
  return response.json.success('Hello, World!')
}
