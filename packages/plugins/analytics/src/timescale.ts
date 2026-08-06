export function timescaleToMs(timescale: string): number {
  switch (timescale) {
    case '1m':
      return 60_000
    case '1h':
      return 3_600_000
    case '1d':
      return 86_400_000
    case '7d':
      return 7 * 86_400_000
    case '30d':
      return 30 * 86_400_000
    default:
      return 0
  }
}
