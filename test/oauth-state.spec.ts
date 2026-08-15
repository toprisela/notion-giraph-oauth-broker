import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { OAuthState, type Env as BrokerEnv } from '../src/index'

interface StoredItemRow {
  [key: string]: SqlStorageValue
  key: string
  expires_at: number
}

function stubFor(name: string): DurableObjectStub<OAuthState> {
  return (env as unknown as BrokerEnv).OAUTH_STATE.getByName(name)
}

describe('OAuthState expiry cleanup', () => {
  it('schedules an alarm when an OAuth attempt is stored', async () => {
    const stub = stubFor('schedules-attempt-cleanup')
    const before = Date.now()

    const response = await stub.fetch('https://broker.test/oauth/notion/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appReturnUri: 'http://localhost:41987/callback' }),
    })

    expect(response.status).toBe(200)
    const { alarm, rows } = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      rows: state.storage.sql
        .exec<StoredItemRow>('SELECT key, expires_at FROM oauth_items')
        .toArray(),
    }))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.key.startsWith('state:')).toBe(true)
    expect(alarm).not.toBeNull()
    expect(alarm as number).toBeGreaterThanOrEqual(before + 599_000)
    expect(alarm as number).toBeLessThanOrEqual(before + 601_000)
  })

  it('deletes expired rows on alarm and reschedules for the next expiry', async () => {
    const stub = stubFor('alarm-removes-expired-rows')
    const now = Date.now()
    const futureExpiry = now + 60_000

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO oauth_items (key, value, expires_at) VALUES (?, ?, ?)',
        'expired',
        '{}',
        now - 1,
      )
      state.storage.sql.exec(
        'INSERT INTO oauth_items (key, value, expires_at) VALUES (?, ?, ?)',
        'future',
        '{}',
        futureExpiry,
      )
      await state.storage.setAlarm(now + 1_000)
    })

    expect(await runDurableObjectAlarm(stub)).toBe(true)

    const { alarm, rows } = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      rows: state.storage.sql
        .exec<StoredItemRow>('SELECT key, expires_at FROM oauth_items ORDER BY key')
        .toArray(),
    }))

    expect(rows.map((row) => row.key)).toEqual(['future'])
    expect(alarm).toBe(futureExpiry)
  })

  it('adopts a pre-existing ticket that does not yet have an alarm', async () => {
    const stub = stubFor('adopts-ticket-without-alarm')
    const ticket = 'legacy-ticket'
    const expiresAt = Date.now() + 60_000

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO oauth_items (key, value, expires_at) VALUES (?, ?, ?)',
        `ticket:${ticket}`,
        JSON.stringify({ attemptId: 'expected-attempt', tokenResponse: {}, expiresAt }),
        expiresAt,
      )
    })

    const response = await stub.fetch('https://broker.test/oauth/notion/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket, attemptId: 'wrong-attempt' }),
    })

    expect(response.status).toBe(401)
    const alarm = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.getAlarm(),
    )
    expect(alarm).toBe(expiresAt)
  })

  it('cancels the alarm after a ticket is redeemed and storage is empty', async () => {
    const stub = stubFor('redeem-cancels-empty-alarm')
    const ticket = 'test-ticket'
    const attemptId = 'test-attempt'
    const expiresAt = Date.now() + 60_000

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO oauth_items (key, value, expires_at) VALUES (?, ?, ?)',
        `ticket:${ticket}`,
        JSON.stringify({ attemptId, tokenResponse: { accessToken: 'test' }, expiresAt }),
        expiresAt,
      )
      await state.storage.setAlarm(expiresAt)
    })

    const response = await stub.fetch('https://broker.test/oauth/notion/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket, attemptId }),
    })

    expect(response.status).toBe(200)
    const { alarm, rowCount } = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      rowCount: state.storage.sql.exec('SELECT key FROM oauth_items').toArray().length,
    }))

    expect(rowCount).toBe(0)
    expect(alarm).toBeNull()
  })

  it('removes an abandoned ticket when its alarm fires', async () => {
    const stub = stubFor('alarm-removes-abandoned-ticket')
    const ticket = 'abandoned-ticket'
    const expiresAt = Date.now() - 1

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO oauth_items (key, value, expires_at) VALUES (?, ?, ?)',
        `ticket:${ticket}`,
        JSON.stringify({ attemptId: 'abandoned-attempt', tokenResponse: {}, expiresAt }),
        expiresAt,
      )
      await state.storage.setAlarm(Date.now())
    })

    await runDurableObjectAlarm(stub)

    const { alarm, rowCount } = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      rowCount: state.storage.sql.exec('SELECT key FROM oauth_items').toArray().length,
    }))

    expect(rowCount).toBe(0)
    expect(alarm).toBeNull()
  })
})
