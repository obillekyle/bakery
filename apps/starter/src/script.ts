const res = await fetch('/api/notes')
const json = await res.json()
const el = document.getElementById('count')
if (el) el.textContent = `${json.data?.length ?? 0} posts`
