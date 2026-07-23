export const DEFAULT_PORT = 3000
export const DEFAULT_HOST = '0.0.0.0'

export const DEFAULT_DB_BACKUPS = 10

export const DEFAULT_SESSION_TTL = 1000 * 60 * 60 * 24
export const DEFAULT_SESSION_PERSIST = DEFAULT_SESSION_TTL * 30

export const DEFAULT_RATE_LIMIT = { max: 100, refill: 10 }

export const DEFAULT_BLOCKED_GLOBS = [
  '**/.env',
  '**/*.env',
  '**/*.sql',
  '**/*.db',
  '**/*.json',
  '**/*.yaml',
  '**/*.yml',
  '**/*.lock',
  '**/.server/**',
  '**/_internal/**',
  '**/.git/**',
  '**/.vscode/**',
  '**/node_modules/**',
  '**/server.config.ts',
  '**/schema.ts',
  '**/.gitignore',
  '**/*.exe',
]
