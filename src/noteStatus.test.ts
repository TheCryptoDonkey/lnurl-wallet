// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createComponent, createSignal} from 'solid-js'
import {render} from 'solid-js/web'
import {MemoryRouter, Route} from '@solidjs/router'
import type {Bearer} from './storage'
import {loadBearers, persistBearer} from './storage'
import {DeviceClient, type DeviceTransport} from './device'
import {clearPendingDeviceOps, readPendingDeviceOps} from './deviceQueue'
import {hashK1} from './lnurlcash'
import {setNoteGroupByMint} from './notePrefs'
import Wallet from './pages/Wallet'

// Exercise the rendered refresh handler, protocol client, encrypted bearer
// storage and durable device queue together. Only the contexts, mint HTTP
// response and physical device transport are supplied by this fixture.
const context = vi.hoisted(() => ({
  wallet: null as any,
  device: null as any,
  notify: vi.fn()
}))
vi.mock('./WalletContext', async importOriginal => ({
  ...(await importOriginal<typeof import('./WalletContext')>()),
  useWallet: () => context.wallet
}))
vi.mock('./DeviceContext', () => ({
  useDevice: () => ({client: () => context.device})
}))
vi.mock('./helpers', async importOriginal => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  notify: context.notify
}))

const K1 = '12'.repeat(32)
const DEVICE_ID = '00000001'
const MIRROR_URL = 'https://mint.example/w?amount=3000'

// The note was exported and redeemed in another wallet. The offline vault
// still holds its confirmed copy until the companion sends mark_spent.
// Marking it requires a separate simulated physical approval; exporting
// for the existing refresh flow is approved by this fixture.
class VaultTransport implements DeviceTransport {
  readonly kind = 'serial' as const
  state: 'confirmed' | 'spent' = 'confirmed'
  commands: {cmd: string; id?: string}[] = []
  private messageHandler: (message: unknown) => void = () => {}
  private disconnectHandler: () => void = () => {}

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler
  }
  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler
  }
  async disconnect(): Promise<void> {
    this.disconnectHandler()
    context.device = null
  }
  async send(message: unknown): Promise<void> {
    const command = message as {cmd: string; id?: string}
    this.commands.push(command)
    if (command.id !== DEVICE_ID) throw new Error('wrong device note')
    if (command.cmd === 'export_secret') {
      queueMicrotask(() => this.messageHandler({ok: true, k1: K1}))
    } else if (command.cmd !== 'mark_spent') {
      throw new Error(`unexpected command: ${command.cmd}`)
    }
  }
  approveMark(): void {
    this.state = 'spent'
    this.messageHandler({ok: true})
  }
  declineMark(): void {
    this.messageHandler({ok: false, error: 'denied'})
  }
}

let dispose: (() => void) | undefined
let notes: () => Bearer[]
let aesKey: CryptoKey
let vault: VaultTransport
let requests: URL[]
let response: 'spent' | 'unknown' | 'pending' | 'offline'
let disconnectDuringLookup: boolean

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
const refresh = () =>
  document
    .querySelector<HTMLButtonElement>('button[title^="Rotate -"]')!
    .click()
const waitForMark = async (count = 1) => {
  await vi.waitFor(() =>
    expect(vault.commands.filter(c => c.cmd === 'mark_spent')).toHaveLength(
      count
    )
  )
}
const assertHashOnly = () => {
  expect(requests).toHaveLength(1)
  expect(requests[0].pathname).toBe('/w')
  expect(requests[0].searchParams.get('h')).toBe(hashK1(K1))
  expect(requests[0].searchParams.has('k1')).toBe(false)
}

beforeEach(async () => {
  localStorage.clear()
  clearPendingDeviceOps()
  context.notify.mockClear()
  setNoteGroupByMint(false)
  vault = new VaultTransport()
  context.device = new DeviceClient(vault)
  requests = []
  response = 'spent'
  disconnectDuringLookup = false
  const [read, write] = createSignal<Bearer[]>([
    {
      id: 'note-1',
      url: MIRROR_URL,
      callback: 'https://mint.example/w/cb',
      amount: 3000,
      verified: true,
      deviceId: DEVICE_ID,
      deviceHash: hashK1(K1),
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
      requests.push(new URL(input.toString()))
      if (disconnectDuringLookup) await vault.disconnect()
      if (response === 'offline') throw new TypeError('offline')
      return {
        json: async () => ({
          status: 'ERROR',
          reason:
            response === 'spent'
              ? 'Note already spent.'
              : response === 'pending'
                ? 'pending'
                : 'Unknown note.'
        })
      } as Response
    })
  )
  mount()
})

afterEach(async () => {
  dispose?.()
  await vault.disconnect()
  document.body.replaceChildren()
  clearPendingDeviceOps()
  vi.unstubAllGlobals()
})

describe('refreshing a vault note redeemed elsewhere', () => {
  it.each([false, true])(
    'retires the device copy after approval (grouped: %s)',
    async grouped => {
      setNoteGroupByMint(grouped)
      refresh()
      await waitForMark()
      assertHashOnly()
      expect(notes()[0]).toMatchObject({
        spent: true,
        url: MIRROR_URL,
        amount: 3000
      })
      expect(await loadBearers(aesKey)).toEqual(notes())
      expect(vault.state).toBe('confirmed')
      expect(readPendingDeviceOps()).toMatchObject([
        {outputs: [], burnDeviceIds: [DEVICE_ID]}
      ])
      vault.approveMark()
      await vi.waitFor(() => expect(readPendingDeviceOps()).toEqual([]))
      expect(vault.state).toBe('spent')
      expect(vault.commands.map(c => c.cmd)).toEqual([
        'export_secret',
        'mark_spent'
      ])
    }
  )

  it.each(['during lookup', 'during approval', 'declined approval'] as const)(
    'retains the queued update across reload and reconnect after %s',
    async interruption => {
      disconnectDuringLookup = interruption === 'during lookup'
      refresh()
      if (disconnectDuringLookup) {
        await vi.waitFor(() => expect(readPendingDeviceOps()).toHaveLength(1))
      } else {
        await waitForMark()
        if (interruption === 'during approval') await vault.disconnect()
        else vault.declineMark()
      }
      await vi.waitFor(() => expect(context.notify).toHaveBeenCalled())
      assertHashOnly()
      expect(vault.state).toBe('confirmed')
      expect((await loadBearers(aesKey))[0].spent).toBe(true)
      const queued = readPendingDeviceOps()
      expect(queued).toMatchObject([{outputs: [], burnDeviceIds: [DEVICE_ID]}])
      expect(JSON.stringify(queued)).not.toContain(K1)

      // Reload the queue module to prove recovery reads persisted data, not
      // an old in-memory queue. DeviceContext calls this same drain on connect.
      dispose!()
      dispose = undefined
      await vault.disconnect()
      vi.resetModules()
      const recoveredQueue = await import('./deviceQueue')
      expect(recoveredQueue.readPendingDeviceOps()).toEqual(queued)
      const marksBeforeReconnect = vault.commands.filter(
        c => c.cmd === 'mark_spent'
      ).length
      const reconnected = new DeviceClient(vault)
      const drain = recoveredQueue.drainPendingDeviceOps(reconnected)
      await waitForMark(marksBeforeReconnect + 1)
      expect(vault.state).toBe('confirmed')
      vault.approveMark()
      await drain
      expect(recoveredQueue.readPendingDeviceOps()).toEqual([])
      expect(vault.state).toBe('spent')
    }
  )

  it.each(['unknown', 'pending', 'offline'] as const)(
    'does not retire either copy on %s',
    async outcome => {
      response = outcome
      refresh()
      await vi.waitFor(() => expect(context.notify).toHaveBeenCalled())
      assertHashOnly()
      expect(notes()[0].spent).not.toBe(true)
      expect((await loadBearers(aesKey))[0].spent).not.toBe(true)
      expect(vault.state).toBe('confirmed')
      expect(readPendingDeviceOps()).toEqual([])
      expect(vault.commands.map(c => c.cmd)).toEqual(['export_secret'])
    }
  )
})
