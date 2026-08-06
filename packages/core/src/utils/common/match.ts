/**
 * Moved to `utils/isomorphic/match` so the browser bundle and the server share
 * one implementation — the prototype-chain fix (`Object.hasOwn` rather than
 * `in`) previously had to be applied to both copies separately.
 */
export * from '../isomorphic/match'
