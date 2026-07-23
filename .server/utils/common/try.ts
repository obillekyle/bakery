import { is } from './misc'

type Wrapped<T, Args extends any[] = []> = T | ((...args: Args) => T)
type MixedPromise<T> = Promise<T> | T

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
        is.function(defaultValue)
          ? (defaultValue as any)(error)
          : defaultValue,
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

type TryType = {
  <T extends MixedPromise<any>>(value: Wrapped<T>): T | null
  catch<T extends MixedPromise<any>>(value: Wrapped<T>): CatchReturn<T>
  return<T extends MixedPromise<any>, D extends MixedPromise<any>>(
    value: Wrapped<T>,
    defaultValue: Wrapped<D, [Error]>,
  ): T | D
  throw: typeof tryThrow
}

export const Try: TryType = Object.assign(
  function Try<T extends MixedPromise<any>>(value: Wrapped<T>): T | null {
    return tryReturn(value, null)
  },
  {
    catch<T extends MixedPromise<any>>(value: Wrapped<T>): CatchReturn<T> {
      if (is.function(value)) {
        return Promise.try(value)
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
  },
)
