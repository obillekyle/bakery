import { response } from '@bakery-framework/core'

export default function handler() {
  return response.json.success('Hello, World!')
}
