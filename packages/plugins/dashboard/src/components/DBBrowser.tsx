/**
 * The Database tab is a signpost, not a browser.
 *
 * This panel used to be the grid editor and a raw SQL prompt, backed by
 * `POST /api/_dashboard/query` and `POST /api/_dashboard/execute-action` and
 * gated by a single environment flag. Both endpoints are gone.
 * `@bakery-framework/plugin-db-explorer` does the same work at `/_db` with an
 * access level per caller instead, so the console points at it rather than
 * shipping a second, weaker copy.
 *
 * Rendered **only when nothing serves `/_db`**. With the explorer mounted the
 * nav entry links straight to it and this panel never appears — a tab whose
 * whole content is "go there" is a click of ceremony in front of going there.
 * Without it, this is what explains where the editor went.
 *
 * Deliberately static: no fetch, no client module, nothing to escape. It is
 * plain markup so that a tab which now only links somewhere cannot grow a
 * data path back by accident.
 */
export function renderDatabaseBrowser() {
  return (
    <div id="panel-database" class="panel">
      <div class="browser-card glass-effect">
        <div class="browser-header">
          <div class="table-info">
            <h2>
              <iconify-icon icon="lucide:database"></iconify-icon>
              <span>Database</span>
            </h2>
          </div>
        </div>

        <div class="modal-fields-container">
          <p>
            The database browser and editor moved to the Database Explorer
            plugin, served at <code>/_db</code>. It browses tables, filters and
            edits rows, and does not accept raw SQL.
          </p>
          <p>
            This console no longer reads or writes table data. If{' '}
            <code>/_db</code> is not reachable, the explorer plugin is not
            registered in your <code>server.config.ts</code>.
          </p>
          <div class="modal-actions">
            <a class="btn btn-primary" href="/_db">
              <iconify-icon icon="lucide:external-link"></iconify-icon>
              <span>Open Database Explorer</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
