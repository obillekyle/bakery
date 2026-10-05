/**
 * The page's default viewport. Without one a phone lays the page out 980 px
 * wide and no `max-width` media query applies (measured in Chrome under 390 px
 * emulation: `innerWidth` 980, and 390 with this tag).
 */
export const VIEWPORT_META =
  '<meta name="viewport" content="width=device-width, initial-scale=1">'

/**
 * Whether `head` markup declares a viewport of its own.
 *
 * The host's `head` is spliced in right after `<head>`, ahead of the shell's
 * own tags, and of two viewport metas Chrome honors the later one (measured:
 * `width=600` after `device-width` reads 600, before it 390). So the default
 * above would override an app's own, and the handler drops it instead.
 */
export function declaresViewport(head: string | undefined): boolean {
  return !!head && /<meta\b[^>]*\sname\s*=\s*["']?viewport\b/i.test(head)
}

export const VUE_HTML_SHELL = `
<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  ${VIEWPORT_META}
  <title>Vue App</title>
  /*__SERVER_VARIABLES__*/
</head>

<body>
  <div id="app"></div>
</body>

</html>`
