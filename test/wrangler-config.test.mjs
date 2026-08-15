import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('persistent Cloudflare observability logs are disabled', async () => {
  const raw = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
  const config = JSON.parse(raw)

  assert.equal(config.observability?.enabled, false)
  assert.equal(config.observability?.logs?.enabled, false)
  assert.equal(config.observability?.logs?.invocation_logs, false)
  assert.equal(config.observability?.logs?.persist, false)
})
