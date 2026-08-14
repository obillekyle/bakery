/**
 * The HTML document the explorer boots into, and all of its CSS.
 *
 * Extracted from `setup.ts` when the client became a data editor: the sheet
 * grew from twenty rules to a hundred and thirty, and a route table with a
 * stylesheet in the middle of it is a route table nobody reads. `setup.ts`
 * keeps the routing and the CSRF policy; this keeps the paint.
 *
 * There is **no markup generated from data here** — the body is an empty
 * `#app` and a module script. Every value the user sees is written by
 * `client/dom.ts` through `textContent`, which is why this plugin has no XSS
 * surface even though it renders arbitrary row contents.
 */

const CSS = `
  :root {
    color-scheme: dark;
    --bg: #0f1115; --panel: #151922; --line: #262b36; --line-soft: #1e2430;
    --text: #e6e8ee; --dim: #9aa3b2; --faint: #5b6472;
    --accent: #2f6feb; --accent-bg: #16233d; --accent-text: #cfe0ff;
    --bad: #ff8ba0; --bad-bg: #2b1620; --good: #7ee2a8;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); }
  #app { display: flex; min-height: 100vh; }

  .side-slot { flex-shrink: 0; }
  .side { width: 230px; padding: 1rem; border-right: 1px solid var(--line); height: 100vh; overflow-y: auto; display: flex; flex-direction: column; gap: .3rem; }
  .table-list { flex: 1; min-height: 0; overflow-y: auto; }
  .system-toggle { border-top: 1px solid var(--line); padding-top: .5rem; cursor: pointer; display: block; }
  .brand { font-size: 1rem; margin: 0 0 .2rem; }
  .note { color: var(--dim); font-size: .8rem; }
  .error, .row-error { color: var(--bad); }
  .error { padding: 1rem; }
  .table-btn { display: block; width: 100%; text-align: left; background: none; border: 0; color: #cfd6e4; padding: .35rem .5rem; border-radius: 6px; cursor: pointer; font: inherit; }
  .table-btn:hover { background: #1a1f2b; }
  .table-btn.active { background: var(--accent-bg); color: var(--accent-text); }
  .table-btn .ro { color: var(--faint); float: right; }

  /* The right-hand column: tab strip, the active view, then the status bar. */
  .column { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100vh; }
  .main { flex: 1; padding: 1rem 1.5rem; min-width: 0; overflow-y: auto; }

  /* Table tabs. Italic is the preview state, borrowed from VS Code. */
  .tabstrip { display: flex; align-items: stretch; gap: 2px; border-bottom: 1px solid var(--line); background: var(--panel); overflow-x: auto; }
  .tab { display: flex; align-items: center; border-right: 1px solid var(--line); background: transparent; max-width: 16rem; }
  .tab.active { background: var(--bg); box-shadow: inset 0 2px 0 var(--accent); }
  .tab-label { font: inherit; font-family: ui-monospace, monospace; font-size: .8rem; background: none; border: 0; color: var(--dim); padding: .45rem .3rem .45rem .8rem; cursor: pointer; max-width: 13rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab.active .tab-label { color: var(--text); }
  .tab.preview .tab-label { font-style: italic; }
  .tab-close { font: inherit; background: none; border: 0; color: var(--faint); cursor: pointer; padding: .2rem .5rem .2rem .2rem; border-radius: 4px; }
  .tab-close:hover { color: var(--bad); background: var(--bad-bg); }
  .tab-new { font: inherit; background: none; border: 0; color: var(--dim); cursor: pointer; padding: .3rem .8rem; }
  .tab-new:hover { color: var(--accent-text); }

  /* Data / Structure / Relations — one level of nesting, and only one. */
  .viewtabs { display: flex; gap: .2rem; padding: .3rem .8rem 0; border-bottom: 1px solid var(--line); background: var(--bg); }
  .viewtab { font: inherit; font-size: .8rem; background: none; border: 0; border-bottom: 2px solid transparent; color: var(--dim); padding: .3rem .7rem; cursor: pointer; }
  .viewtab:hover { color: var(--text); }
  .viewtab.active { color: var(--accent-text); border-bottom-color: var(--accent); }
  .newtab { padding: 2rem; }

  .statusbar { border-top: 1px solid var(--line); background: var(--panel); color: var(--dim); font-size: .75rem; padding: .3rem 1rem; flex-shrink: 0; font-family: ui-monospace, monospace; }
  .statusbar.dirty { color: var(--bad); }

  /* Structure and Relations. */
  .structure, .relations { display: flex; flex-direction: column; gap: 1.2rem; }
  .structure-section h3 { margin: 0 0 .3rem; font-size: .9rem; }
  .structure-grid td { white-space: normal; }
  .relation-list { display: flex; flex-direction: column; gap: .3rem; margin-top: .4rem; }
  .relation { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
  .relation-cols { font-family: ui-monospace, monospace; font-size: .8rem; color: var(--dim); }

  /* The filter builder: a chip per condition. */
  .filter-bar { display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; margin-bottom: .6rem; }
  .filter-chip { display: flex; gap: .2rem; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: .15rem .3rem .15rem .5rem; }
  .filter-chip .sel { border: 0; background: transparent; font-size: .78rem; }
  .filter-value { font: inherit; font-size: .78rem; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: .1rem .35rem; width: 8rem; }
  .filter-drop { border: 0; background: none; color: var(--faint); padding: 0 .4rem; }
  .filter-drop:hover { color: var(--bad); }
  .filter-add { font-size: .78rem; }
  .filter-clash { color: var(--bad); font-size: .75rem; }

  .table-head { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
  .table-head h2 { margin: .2rem 0 .8rem; font-family: ui-monospace, monospace; font-size: 1rem; }
  .banner { border: 1px solid var(--line); border-left: 3px solid var(--accent); background: var(--panel); padding: .5rem .8rem; border-radius: 6px; margin: 0 0 .8rem; }
  .banner.warn { border-left-color: var(--bad); }
  .crumbs { display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; margin-bottom: .5rem; }
  .badge { background: var(--accent-bg); color: var(--accent-text); border-radius: 999px; padding: .05rem .5rem; font-size: .75rem; }
  .badge.dirty { background: var(--bad-bg); color: var(--bad); }

  .toolbar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: .6rem; }
  .btn { font: inherit; padding: .25rem .7rem; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; }
  .btn:hover:not(:disabled) { border-color: var(--accent); }
  .btn:disabled { opacity: .4; cursor: default; }
  .btn.primary { border-color: var(--accent); background: var(--accent-bg); color: var(--accent-text); }
  .btn.danger-btn { border-color: var(--bad); color: var(--bad); }

  .scroll { overflow: auto; border: 1px solid var(--line); border-radius: 8px; max-height: 70vh; }
  .grid { border-collapse: collapse; width: 100%; font-size: .82rem; }
  .grid th { text-align: left; padding: .45rem .7rem; background: var(--panel); cursor: pointer; white-space: nowrap; position: sticky; top: 0; z-index: 1; }
  .grid th.pk::after { content: ' PK'; color: var(--faint); font-size: .7rem; }
  .grid td { padding: .3rem .7rem; border-top: 1px solid var(--line-soft); font-family: ui-monospace, monospace; white-space: nowrap; max-width: 26rem; overflow: hidden; text-overflow: ellipsis; }
  .grid td.null { color: var(--faint); font-style: italic; }
  .grid td.num { text-align: right; }
  .grid td.staged { background: var(--accent-bg); }
  .grid td.bad { outline: 1px solid var(--bad); background: var(--bad-bg); }
  .grid td.at { outline: 2px solid var(--accent); outline-offset: -2px; }
  .grid td.editing { padding: .1rem .2rem; white-space: normal; overflow: visible; }
  .grid td.pick, .grid th.pick { width: 2rem; text-align: center; }
  .grid tr.focused { background: #1b2436; }
  .grid tr[aria-busy='true'] { opacity: .5; }
  .fk { font: inherit; background: none; border: 0; border-bottom: 1px dotted var(--accent); color: var(--accent-text); cursor: pointer; padding: 0; }

  .row-bar-row { display: none; }
  .row-bar-row.open { display: table-row; }
  .row-bar-row td { background: var(--panel); }
  .row-bar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }

  .editor { display: flex; gap: .25rem; align-items: center; }
  .editor.invalid .ed { border-color: var(--bad); }
  .editor.is-null .ed { opacity: .4; }
  .ed { font: inherit; font-family: ui-monospace, monospace; background: var(--bg); color: var(--text); border: 1px solid var(--accent); border-radius: 4px; padding: .15rem .3rem; min-width: 6rem; }
  .ed-json { min-width: 22rem; }
  .ed-long { min-width: 22rem; resize: vertical; }
  .ed-check { min-width: 0; }
  .ed-null { font: inherit; width: 1.6rem; border-radius: 4px; border: 1px solid var(--line); background: var(--panel); color: var(--dim); cursor: pointer; }
  .ed-null[aria-pressed='true'] { border-color: var(--accent); color: var(--accent-text); }
  .ed-null:disabled { opacity: .3; cursor: not-allowed; }
  .ed-note { color: var(--bad); font-size: .75rem; }

  .pager { margin-top: .8rem; display: flex; gap: .5rem; align-items: center; }
  .filters { display: flex; gap: .4rem; flex-wrap: wrap; margin-bottom: .5rem; }
  .filters input { font: inherit; font-size: .78rem; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: .1rem .35rem; width: 8rem; }

  dialog { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.2rem; max-width: 42rem; }
  dialog.wide { max-width: 80rem; width: 90vw; }
  dialog::backdrop { background: #0008; }
  dialog h3 { margin: 0 0 .5rem; }
  dialog h4 { margin: .8rem 0 .3rem; font-size: .85rem; color: var(--dim); }
  .sel { font: inherit; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: .15rem .3rem; }

  /* The row side panel — where JSON, long text and both graph directions live. */
  .panel { position: fixed; top: 0; right: 0; width: min(38rem, 100vw); height: 100vh; overflow-y: auto; background: var(--panel); border-left: 1px solid var(--line); padding: 1rem; z-index: 30; }
  .panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
  .panel-title h3 { margin: 0; font-family: ui-monospace, monospace; }
  .panel-fields { display: flex; flex-direction: column; gap: .6rem; margin: .8rem 0; }
  .panel-field { display: flex; flex-direction: column; gap: .15rem; }
  .panel-label { font-family: ui-monospace, monospace; font-size: .8rem; }
  .panel-value { font-family: ui-monospace, monospace; color: var(--dim); word-break: break-all; }
  .panel-refs { margin-top: 1rem; }
  .panel-ref { display: flex; gap: .5rem; align-items: center; margin: .3rem 0; }
  .panel-field .editor { width: 100%; }
  .panel-field .ed { width: 100%; }

  .undo-bar { position: fixed; left: 50%; bottom: 1.2rem; transform: translateX(-50%); display: flex; gap: .8rem; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: .5rem .9rem; z-index: 40; }
  .undo-bar.error { border-color: var(--bad); color: var(--bad); }

  .drop { border: 2px dashed var(--line); border-radius: 10px; padding: 2rem; text-align: center; }
  .drop.over { border-color: var(--accent); background: var(--accent-bg); }
  .import-stage { display: flex; flex-direction: column; gap: .4rem; max-height: 75vh; overflow-y: auto; }
  .import-head { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
  .map-row { display: grid; grid-template-columns: 10rem 14rem 14rem auto auto; gap: .5rem; align-items: center; padding: .15rem 0; }
  .map-name { font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; }
  .map-samples { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .unmapped-row { display: flex; gap: .5rem; align-items: center; font-family: ui-monospace, monospace; font-size: .8rem; }
  .tag { border-radius: 4px; padding: 0 .35rem; font-size: .7rem; font-family: ui-sans-serif, system-ui, sans-serif; }
  .tag.required { background: var(--bad-bg); color: var(--bad); }
  .tag.default { background: var(--accent-bg); color: var(--accent-text); }
  .tag.nullable { background: #1a1f2b; color: var(--dim); }
  .insert-rows { display: flex; flex-direction: column; gap: .8rem; max-height: 50vh; overflow-y: auto; }
  .insert-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: .4rem; border-top: 1px solid var(--line-soft); padding-top: .4rem; }
`

export const SHELL: string = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Database explorer</title>
<style>${CSS}</style>
</head>
<body>
<div id="app"><p class="note" style="padding:1rem">loading…</p></div>
<script type="module" src="/_db/app.js"></script>
</body>
</html>`
