/**
 * Request-body validation for route modules.
 *
 * `defineRoute<{ title: string }>` declares a body shape and enforces nothing —
 * the scaffolder's own template says so twice: *"declares the contract — it
 * does not validate it. The body is still client input."* Every route was left
 * to hand-check or not, and most did not.
 *
 * **No schema library is bundled, and none is depended on.** `@bakery-framework/
 * core` has zero runtime dependencies and that is worth keeping, so validation
 * accepts two shapes it can consume without knowing who produced them:
 *
 *   - **Standard Schema** (`~standard`) — the shared interface zod, valibot and
 *     arktype all implement. Bring your own library; Bakery never imports it.
 *   - **A plain function** that returns the parsed value or throws.
 *
 * The second exists because the first is overkill for `body => { if (!body.id)
 * throw new Error('id required'); return body }`, and a framework that forces a
 * dependency for that has made the common case worse.
 */

/** The subset of Standard Schema v1 that validation needs. */
export interface StandardSchemaLike<T> {
  '~standard': {
    version: 1
    vendor: string
    validate(value: unknown): StandardResult<T> | Promise<StandardResult<T>>
  }
}

type StandardResult<T> =
  | { value: T; issues?: undefined }
  | { issues: readonly StandardIssue[] }

interface StandardIssue {
  message: string
  path?: readonly (PropertyKey | { key: PropertyKey })[]
}

/** A function validator: return the parsed value, or throw to reject. */
export type FunctionValidator<T> = (value: unknown) => T | Promise<T>

export type Validator<T> = StandardSchemaLike<T> | FunctionValidator<T>

/** One human-readable problem, with the field path when the schema gave one. */
export interface ValidationIssue {
  path: string
  message: string
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] }

function isStandardSchema<T>(v: Validator<T>): v is StandardSchemaLike<T> {
  return typeof v === 'object' && v !== null && '~standard' in v
}

/**
 * Render a Standard Schema path as dotted notation.
 *
 * Segments may be plain keys or `{ key }` objects — the spec allows both, and a
 * library that uses the object form would otherwise render as `[object Object]`
 * in the very message meant to tell someone which field is wrong.
 */
function renderPath(path: StandardIssue['path']): string {
  if (!path?.length) return ''
  return path
    .map(seg => (typeof seg === 'object' && seg !== null ? seg.key : seg))
    .join('.')
}

/**
 * Run a validator, never throwing.
 *
 * A function validator that throws is a *rejection*, not a crash: that is the
 * whole idiom for the plain-function form. Its message becomes the issue, so
 * `throw new Error('id must be a number')` reaches the client as written.
 */
export async function validate<T>(
  validator: Validator<T>,
  value: unknown,
): Promise<ValidationResult<T>> {
  if (isStandardSchema(validator)) {
    const result = await validator['~standard'].validate(value)
    if (result.issues) {
      return {
        ok: false,
        issues: result.issues.map(issue => ({
          path: renderPath(issue.path),
          message: issue.message,
        })),
      }
    }
    return { ok: true, value: result.value }
  }

  try {
    return { ok: true, value: await validator(value) }
  } catch (error: any) {
    return {
      ok: false,
      issues: [{ path: '', message: error?.message ?? 'Invalid request body' }],
    }
  }
}
