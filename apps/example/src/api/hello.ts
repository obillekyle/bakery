import { response } from '@bakery/core'

export default function handler() {
  return response.json.success('Hello, World!')
}
