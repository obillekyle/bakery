export const Math2 = {
  clamp(value: number, min?: number, max?: number): number {
    min ??= -Infinity
    max ??= Infinity
    return Math.min(Math.max(value, min), max)
  },

  step(value: number, step: number): number {
    return Math.round(value / step) * step
  },
}
