export class LRUCache<K, V> extends Map<K, V> {
  /**
   * Called with the entry dropped to make room. Needed when values own a
   * resource that must be released — an evicted prepared statement, for
   * instance, otherwise leaks until the process exits.
   */
  private readonly onEvict?: (key: K, value: V) => void

  constructor(
    public readonly maxSize: number,
    onEvict?: (key: K, value: V) => void,
  ) {
    super()
    if (maxSize <= 0) throw new Error('LRUCache size must be greater than 0')
    this.onEvict = onEvict
  }

  get(key: K): V | undefined {
    const val = super.get(key)
    // `has` only to disambiguate a stored `undefined` from a miss — on the
    // common hit this is two map operations instead of four.
    if (val === undefined && !super.has(key)) return undefined
    super.delete(key)
    super.set(key, val as V)
    return val
  }

  set(key: K, value: V): this {
    if (super.has(key)) super.delete(key)
    super.set(key, value)
    if (this.size > this.maxSize) {
      const first = this.keys().next().value
      if (first !== undefined) {
        const evicted = super.get(first!)
        super.delete(first!)
        if (evicted !== undefined) this.onEvict?.(first!, evicted)
      }
    }
    return this
  }
}
