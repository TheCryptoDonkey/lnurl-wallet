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

const button = (
  text: string,
  root: ParentNode = document
): HTMLButtonElement => {
  const match = [...root.querySelectorAll('button')].find(
    b => b.textContent?.trim() === text
  )
  if (!match) throw new Error(`Missing button: ${text}`)
  return match
}
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
  document
    .querySelector<HTMLButtonElement>('button[title^="Rotate -"]')!
    .click()
  await vi.waitFor(() => expect(requests).toHaveLength(1))
}
const openSecretCheck = () => {
  button('Check with secret').click()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'spending secret to'
  )
  expect(requests.every(url => !url.searchParams.has('k1'))).toBe(true)
}
const confirmSecretCheck = () =>
  button(
    'Check with secret',
    document.querySelector('[role="dialog"]')!
  ).click()

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
              : mintState === 'burned' && url.searchParams.has('k1')
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
    'preserves an inconclusive note and confirms spent only after disclosure (grouped: %s)',
    async grouped => {
      setNoteGroupByMint(grouped)
      await refresh()
      await vi.waitFor(() =>
        expect(
          document.querySelector('[role="status"]')?.textContent
        ).toContain('Status unknown')
      )
      expect(requests[0].searchParams.get('h')).toBe(hashK1(K1))
      expect(requests[0].searchParams.has('k1')).toBe(false)
      expect(notes()[0]).toMatchObject({
        url: ORIGINAL_URL,
        amount: 3000,
        statusUnknown: true
      })
      expect(notes()[0].spent).not.toBe(true)
      expect(await loadBearers(aesKey)).toEqual(notes())
      // The warning survives a remount, rather than disappearing with a toast.
      dispose!()
      document.body.replaceChildren()
      mount()
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        'last known value'
      )
      openSecretCheck()
      button('Cancel', document.querySelector('[role="dialog"]')!).click()
      expect(requests).toHaveLength(1)
      openSecretCheck()
      confirmSecretCheck()
      await vi.waitFor(() => expect(notes()[0].spent).toBe(true))
      expect(requests).toHaveLength(2)
      expect(requests[1].searchParams.get('k1')).toBe(K1)
      expect(requests[1].searchParams.has('h')).toBe(false)
      expect(notes()[0]).toMatchObject({
        url: ORIGINAL_URL,
        amount: 3000,
        statusUnknown: false
      })
      expect((await loadBearers(aesKey))[0].spent).toBe(true)
    }
  )

  it('rotates a live note after an explicit check on a mint without hash lookup', async () => {
    mintState = 'live'
    hashSupported = false
    await refresh()
    await vi.waitFor(() => expect(notes()[0].statusUnknown).toBe(true))
    openSecretCheck()
    confirmSecretCheck()
    await vi.waitFor(() => expect(notes()[0].statusUnknown).toBe(false))
    expect(notes()[0].spent).not.toBe(true)
    expect(notes()[0].amount).toBe(3000)
    expect(noteK1(notes()[0].url)).not.toBe(K1)
    expect(requests.map(url => url.pathname)).toEqual(['/w', '/w', '/w/cb'])
    expect(hashK1(noteK1(notes()[0].url)!)).toBe(
      requests[2].searchParams.get('h')
    )
    expect(await loadBearers(aesKey)).toEqual(notes())
  })

  it('retains a never-issued note even after checking with its secret', async () => {
    mintState = 'never-issued'
    await refresh()
    await vi.waitFor(() => expect(notes()[0].statusUnknown).toBe(true))
    openSecretCheck()
    confirmSecretCheck()
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    )
    expect(notes()[0].spent).not.toBe(true)
    expect((await loadBearers(aesKey))[0]).toMatchObject({
      url: ORIGINAL_URL,
      amount: 3000,
      statusUnknown: true
    })
    expect(requests).toHaveLength(2)
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
