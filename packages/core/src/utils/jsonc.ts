export function parseJSONC(jsonc: string): any {
  if (!jsonc.trim()) return null

  const clean = jsonc.replace(
    /("(?:\\.|[^"\\])*")|(\/\/.*|\/\*[\s\S]*?\*\/)|,\s*(?=[\]}])/g,
    (_, stringLiteral) => (stringLiteral ? stringLiteral : ''),
  )

  return JSON.parse(clean)
}
