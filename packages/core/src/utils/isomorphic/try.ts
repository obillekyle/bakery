import type { MixedPromise, Wrapped } from '../../types'
import { is } from './is'

// These were declared again, here, byte-for-byte identical to `types.d.ts` —
// the second copy convention 5 exists to prevent. `isomorphic.test.ts` catches
// a duplicated *value* by reference identity, and a type has no runtime
// identity to compare, so nothing saw it.
//
// A type-only import is safe in an isomorphic module: `verbatimModuleSyntax`
// makes the compiler reject a value-position import of these, so it cannot
// become a runtime module edge into the browser bundle.

type CatchReturn<T extends MixedPromise<any>> =
  T extends Promise<infer V>
    ? Promise<[Error, null] | [null, V]>
    : MixedPromise<[Error, null] | [null, T]>

function tryThrow<T>(
  callback: () => MixedPromise<T>,
  error?: string | Error,
): Promise<T> {
  return Promise.try(callback).catch((err: any) => {
    throw is.string(error) ? new Error(error) : error || err
  })
}

function tryReturn<T extends MixedPromise<any>, D extends MixedPromise<any>>(
  value: Wrapped<T>,
  defaultValue: Wrapped<D, [Error]>,
): T | D {
  try {
    const unwrapped = is.function(value) ? (value as any)() : value
    if (
      unwrapped instanceof Promise ||
      (is.object(unwrapped) && is.function((unwrapped as any).catch))
    ) {
      return (unwrapped as any).catch((error: any) =>
        is.function(defaultValue) ? (defaultValue as any)(error) : defaultValue,
      ) as any
    }
    return unwrapped
  } catch (error: any) {
    const unwrappedDefault = is.function(defaultValue)
      ? (defaultValue as any)(error)
      : defaultValue
    return unwrappedDefault
  }
}

function trySilent<T extends MixedPromise<any>>(value: Wrapped<T>): T | null {
  return tryReturn(value, null as any)
}

type TryType = {
  <T extends MixedPromise<any>>(value: Wrapped<T>): T | null
  catch<T extends MixedPromise<any>>(value: Wrapped<T>): CatchReturn<T>
  return<T extends MixedPromise<any>, D extends MixedPromise<any>>(
    value: Wrapped<T>,
    defaultValue: Wrapped<D, [Error]>,
  ): T | D
  throw: typeof tryThrow
  /**
   * Alias for calling `Try` directly. Kept because the browser global has
   * always exposed it; unifying the two copies is not the place to shrink a
   * published surface.
   */
  silent<T extends MixedPromise<any>>(value: Wrapped<T>): T | null
}

export const Try: TryType = Object.assign(
  function Try<T extends MixedPromise<any>>(value: Wrapped<T>): T | null {
    return trySilent(value)
  },
  {
    catch<T extends MixedPromise<any>>(value: Wrapped<T>): CatchReturn<T> {
      if (is.function(value)) {
        return Promise.try(value as any)
          .then(data => [null, data])
          .catch(error => [error, null]) as any
      }
      if (value instanceof Promise) {
        return value
          .then(data => [null, data])
          .catch(error => [error, null]) as any
      }
      return [null, value] as any
    },
    return: tryReturn,
    throw: tryThrow,
    silent: trySilent,
  },
)

export const tryCatch = Try.catch
