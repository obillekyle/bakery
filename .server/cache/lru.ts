export class LRUCache<K, V> extends Map<K, V> {
  constructor(public readonly maxSize: number) {
    super()
    if (maxSize <= 0) throw new Error('LRUCache size must be greater than 0')
  }

  get(key: K): V | undefined {
    if (!super.has(key)) return undefined
    const val = super.get(key)!
    super.delete(key)
    super.set(key, val)
    return val
  }

  set(key: K, value: V): this {
    if (super.has(key)) super.delete(key)
    super.set(key, value)
    if (this.size > this.maxSize) {
      const first = this.keys().next().value
      if (first !== undefined) super.delete(first!)
    }
    return this
  }
}
