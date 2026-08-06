/**
 * WebSocket clients subscribed to the live log stream.
 *
 * `LiveReloadHandler` owns membership — it adds a socket on
 * `subscribe_logger` and removes it on close. Consumers (the dashboard's
 * log broadcast, the analytics `activeLoggers` gauge) only read.
 *
 * This lives in core rather than a plugin deliberately: it used to be
 * defined in `plugins/analytics/core`, which made core import from a
 * plugin — a backwards edge that blocks packaging core on its own.
 */
export const connectedLoggers = new Set<any>()
