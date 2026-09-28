import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The parsed body of the request a `<script server>` block is running for.
 *
 * Separate from core's `getRequest()` deliberately: the request is core's and
 * every surface has one, while `body` is this plugin's own computation
 * (`VueHandler.params(req, finalParams)`, which merges route params with the
 * parsed payload). A `.tsx` page receives its body as a function argument and
 * has no use for this.
 *
 * Why it exists at all is the same reason as `getRequest()`. The block used
 * to reach `body` as a global declared in `vue.d.ts`, which only works if
 * that `.d.ts` lands in whatever tsconfig project an editor resolves for the
 * SFC, and for an SFC it routinely does not. An import cannot fail that way,
 * it carries a real type instead of `any`, and it reaches a helper the block
 * calls rather than stopping at the wrapper's parameter list.
 */
const bodyStore = new AsyncLocalStorage<{ body: unknown }>()

/** Run `fn` with `body` visible to `getBody()`. Called by the plugin only. */
export function runWithServerBody<T>(body: unknown, fn: () => T): T {
  return bodyStore.run({ body }, fn)
}

/**
 * The request body, inside a `<script server>` block or anything it calls.
 *
 * Unlike {@link import('@bakery-framework/core').getRequest} this does **not**
 * throw when absent: a GET with no payload and no route params is an ordinary
 * request, and `undefined` is the honest answer rather than an error
 * condition. The type parameter is the caller's assertion about a shape the
 * framework cannot know, exactly as it was when this was an `any` global.
 */
export function getBody<T = unknown>(): T | undefined {
  return bodyStore.getStore()?.body as T | undefined
}
