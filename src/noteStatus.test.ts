// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createComponent, createSignal} from 'solid-js'
import {render} from 'solid-js/web'
import {MemoryRouter, Route} from '@solidjs/router'
import type {Bearer} from './storage'
import {loadBearers, persistBearer} from './storage'
import {hashK1, noteK1} from './lnurlcash'
import {setNoteGroupByMint} from './notePrefs'
import Wallet from './pages/Wallet'

// Render the real Wallet and BearerCard, with real lookup/error handling
// and encrypted persistence. Only the contexts and mint HTTP responses are
// supplied here: the regression was between the lookup and the UI handler.
const context = vi.hoisted(() => ({wallet: null as any, notify: vi.fn()}))
vi.mock('./WalletContext', async importOriginal => ({
  ...(await importOriginal<typeof import('./WalletContext')>()),
  useWallet: () => context.wallet
}))
vi.mock('./DeviceContext', () => ({useDevice: () => ({client: () => null})}))
vi.mock('./helpers', async importOriginal => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  notify: context.notify
}))

const K1 = '12'.repeat(32)
const ORIGINAL_URL = `https://mint.example/w?k1=${K1}&amount=3000`
const MINT_KEY = `02${'11'.repeat(32)}`
let dispose: (() => void) | undefined
let notes: () => Bearer[]
let aesKey: CryptoKey
let requests: URL[]
let mintState: 'live' | 'burned' | 'never-issued' | 'pending' | 'offline'
let hashSupported: boolean

const mount = () => {
  const container = document.createElement('div')
  document.body.append(container)
  dispose = render(
    () =>
      createComponent(MemoryRouter, {
        get children() {
          return createComponent(Route, {path: '/', component: Wallet})
        }
      }),
    container
  )
}
const refresh = async () => {
  const previous = requests.length
  document
    .querySelector<HTMLButtonElement>('button[title^="Rotate -"]')!
    .click()
  await vi.waitFor(() => expect(requests.length).toBeGreaterThan(previous))
}

beforeEach(async () => {
  localStorage.clear()
  context.notify.mockClear()
  setNoteGroupByMint(false)
  mintState = 'burned'
  hashSupported = true
  requests = []
  const [read, write] = createSignal<Bearer[]>([
    {
      id: 'note-1',
      url: ORIGINAL_URL,
      callback: 'https://mint.example/w/cb',
      amount: 3000,
      verified: true,
      createdAt: 1,
      updatedAt: 1
    }
  ])
  notes = read
  aesKey = await crypto.subtle.generateKey(
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  )
  await persistBearer(aesKey, notes()[0])
  context.wallet = {
    state: () => 'unlocked',
    bearers: read,
    unlock: vi.fn(),
    addBearer: vi.fn(),
    removeBearer: vi.fn(),
    logActivity: vi.fn(),
    updateBearer: async (id: string, changes: Partial<Bearer>) => {
      const updated = {
        ...read().find(b => b.id === id)!,
        ...changes,
        updatedAt: Date.now()
      }
      await persistBearer(aesKey, updated)
      write(old => old.map(b => (b.id === id ? updated : b)))
    }
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(input.toString())
      requests.push(url)
      if (mintState === 'offline') throw new TypeError('offline')
      let body: object
      if (url.pathname === '/w/cb') {
        expect(mintState).toBe('live')
        expect(url.searchParams.get('k1')).toBe(K1)
        expect(url.searchParams.get('h')).toMatch(/^[a-f0-9]{64}$/)
        mintState = 'burned'
        body = {status: 'OK', sig: '00'.repeat(65)}
      } else if (url.searchParams.has('h') && !hashSupported) {
        body = {status: 'ERROR', reason: 'Unknown note.'}
      } else if (mintState === 'live') {
        body = {
          tag: 'withdrawRequest',
          callback: 'https://mint.example/w/cb',
          maxWithdrawable: 3000,
          minWithdrawable: 3000,
          mintPubkey: MINT_KEY,
          ...(url.searchParams.has('k1')
            ? {k1: url.searchParams.get('k1')}
            : {})
        }
      } else {
        body = {
          status: 'ERROR',
          reason:
            mintState === 'pending'
              ? 'pending'
              : mintState === 'burned'
                ? 'Note already spent.'
                : 'Unknown note.'
        }
      }
      return {json: async () => body} as Response
    })
  )
  mount()
})

afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('refreshing a note redeemed outside this wallet', () => {
  it.each([false, true])(
    'marks a spent hash as spent without exposing the secret (grouped: %s)',
    async grouped => {
      setNoteGroupByMint(grouped)
      await refresh()
      await vi.waitFor(() => expect(notes()[0].spent).toBe(true))
      expect(requests).toHaveLength(1)
      expect(requests[0].searchParams.get('h')).toBe(hashK1(K1))
      expect(requests[0].searchParams.has('k1')).toBe(false)
      expect(notes()[0]).toMatchObject({
        url: ORIGINAL_URL,
        amount: 3000,
        statusUnknown: false
      })
      expect(await loadBearers(aesKey)).toEqual(notes())
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(document.querySelector('[role="status"]')).toBeNull()
      expect(context.notify).toHaveBeenCalledWith(
        'Already spent - marked spent in this wallet.',
        expect.anything()
      )
    }
  )

  it.each(['never-issued', 'legacy hash lookup'] as const)(
    'keeps %s inconclusive, without a secret-disclosing retry',
    async variant => {
      mintState = variant === 'never-issued' ? 'never-issued' : 'burned'
      hashSupported = variant !== 'legacy hash lookup'
      await refresh()
      await vi.waitFor(() => expect(notes()[0].statusUnknown).toBe(true))
      expect(notes()[0]).toMatchObject({url: ORIGINAL_URL, amount: 3000})
      expect(notes()[0].spent).not.toBe(true)
      expect(await loadBearers(aesKey)).toEqual(notes())
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        'last known value'
      )
      expect(document.body.textContent).toContain(
        'Includes 3 sats with unknown status'
      )
      expect(document.body.textContent).not.toContain('Check with secret')
      expect(requests).toHaveLength(1)
      expect(requests[0].searchParams.has('k1')).toBe(false)
      dispose!()
      document.body.replaceChildren()
      mount()
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        'Status unknown'
      )
    }
  )

  it('clears the inconclusive status when a later refresh finds a live note', async () => {
    hashSupported = false
    await refresh()
    await vi.waitFor(() => expect(notes()[0].statusUnknown).toBe(true))
    hashSupported = true
    mintState = 'live'
    await refresh()
    await vi.waitFor(() => expect(notes()[0].statusUnknown).toBe(false))
    expect(notes()[0].spent).not.toBe(true)
    expect(noteK1(notes()[0].url)).not.toBe(K1)
    expect(requests.map(url => url.pathname)).toEqual(['/w', '/w', '/w/cb'])
    // Only the authorised rotate callback carries the secret.
    expect(
      requests
        .filter(url => url.pathname === '/w')
        .every(url => !url.searchParams.has('k1'))
    ).toBe(true)
    expect(hashK1(noteK1(notes()[0].url)!)).toBe(
      requests[2].searchParams.get('h')
    )
    expect(await loadBearers(aesKey)).toEqual(notes())
  })

  it.each(['pending', 'offline'] as const)(
    'does not turn %s into a spent or unknown-note verdict',
    async state => {
      mintState = state
      await refresh()
      await vi.waitFor(() => expect(context.notify).toHaveBeenCalled())
      expect(notes()[0]).toMatchObject({url: ORIGINAL_URL, amount: 3000})
      expect(notes()[0].spent).not.toBe(true)
      expect(notes()[0].statusUnknown).not.toBe(true)
      expect(requests.every(url => !url.searchParams.has('k1'))).toBe(true)
      expect(await loadBearers(aesKey)).toEqual(notes())
    }
  )
})
