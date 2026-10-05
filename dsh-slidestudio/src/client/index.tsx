import type { Context as ClientContext } from '@deepseek-ai/cordis'
import React from 'react'
import type { SliceSessionSnapshot } from '@open-slidestudio/dsh-slides-host/protocol'

export const name = 'dsh-slidestudio-client'
// Only the slots service is required up front: without dsh-personal the feature
// still mounts as its own top-level panel; when Personal is present the same
// page is re-registered inside its sidebar instead (see ctx.inject below).
export const inject = ['slots']

type PersonalRegistry = {
  open?: (feature: string) => boolean
  suspend?: () => (restore?: boolean) => void
  register: (feature: {
    id: string
    title: string
    description?: string
    order?: number
    component: React.ComponentType
  }) => () => void
}

type SlotsService = {
  inject(slot: string, callback: () => (() => void) | void): () => void
  register(entry: Record<string, unknown>, component: React.ComponentType): () => void
}

type ShortcutCatalogRow = {
  id: string
  aria?: string
}

type ShortcutsService = {
  catalog: { getSnapshot(): readonly ShortcutCatalogRow[] }
}

type LocaleService = {
  getLocale(): { active?: string }
  subscribe(listener: () => void): () => void
}

type LayoutService = {
  selectPanel(panelId: string | null): void
  panelInfo?: { getSnapshot(): { activePanelId: string | null } }
  beginNavigation?(): AbortSignal
}

type SessionsService = {
  list: {
    getSnapshot(): { byId: Record<string, { projectionValues?: { agentPreset?: unknown } }> }
    subscribe(listener: () => void): () => void
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    personal?: PersonalRegistry
    slots: SlotsService
  }
}

/** Use the Host's rendered settings control on Web and native Desktop alike.
 * Desktop ignores synthetic DOM shortcut events. RC2 exposes no public command
 * invocation API, so use its slot/ARIA controls without touching private stores.
 */
function activateSettingsControl(ctx: ClientContext): boolean {
  const trigger = document.querySelector('[data-slot="sidebar.settings"] [data-slot="settings.trigger"]')
    ?.closest('button')
  if (trigger && !trigger.disabled) {
    trigger.click()
    return true
  }
  const launcher = document.querySelector<HTMLButtonElement>(
    '[data-slot="sidebar.settings"] [data-slot="settings.launcher"] button[aria-haspopup="menu"]',
  )
  if (!launcher || launcher.disabled) return false
  if (launcher.getAttribute('aria-expanded') !== 'true') {
    launcher.click()
    return false // React mounts the portal menu before the next poll.
  }
  const shortcuts = ctx.get('shortcuts') as ShortcutsService | undefined
  const aria = shortcuts?.catalog.getSnapshot().find(row => String(row.id) === 'settings.open')?.aria
  const matches = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button[role="menuitem"]')]
    .filter(button => {
      if (button.disabled) return false
      if (aria && button.getAttribute('aria-keyshortcuts') === aria) return true
      // The user may unbind the command; the official zh/en menu remains usable.
      const label = button.cloneNode(true) as HTMLElement
      label.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove())
      return ['设置', 'Settings'].includes(label.textContent?.trim() ?? '')
    })
  if (matches.length !== 1) return false
  matches[0].click()
  return true
}

/** The hub inside the iframe follows DSH's own Language setting. */
let currentLang: 'zh' | 'en' = 'zh'

function activeLang(ctx: ClientContext): 'zh' | 'en' {
  try {
    const locale = ctx.get('locale') as LocaleService | undefined
    return locale?.getLocale?.().active === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

function slideTitle(): string {
  return currentLang === 'en' ? 'Slides' : '演示文稿'
}

function slideDescription(): string {
  return currentLang === 'en'
    ? 'Turn one sentence into a polished slide deck'
    : '一句话把想法变成漂亮的演示文稿'
}

/** Push the active locale into every app iframe the plugin mounted. */
function broadcastLang(): void {
  for (const frame of document.querySelectorAll('iframe')) {
    try {
      if (!new URL(frame.src, location.href).pathname.startsWith('/app/')) continue
      frame.contentWindow?.postMessage({ type: 'oss:locale', lang: currentLang }, location.origin)
    } catch {
      // Cross-origin or detached frame; it resolves its own language.
    }
  }
}

function settingsModalOpen(): boolean {
  return document.querySelector('[data-shortcut-modal="settings"]') !== null
}

/** Any other dialog holding the modal layer — e.g. the settings.onboarding
 *  key prompt that re-mounts on a fresh home — blocks `settings.open`. */
function otherDialogOpen(): boolean {
  return (
    document.querySelector('[role="dialog"][aria-modal="true"]:not([data-shortcut-modal="settings"])') !== null
  )
}

/** The slot renderer marks each mount site with `data-slot` — the anchor is
 *  absent on pages (like Personal's) that never render `sidebar.settings`. */
function settingsUiMounted(): boolean {
  return document.querySelector('[data-slot="sidebar.settings"]') !== null
}

/**
 * Open the DSH settings panel. The settings modal renders inside the
 * `sidebar.settings` occupant, which Personal pages don't mount — dispatching
 * there would only leak a latent open flag into the shell store. When the
 * mount is absent, switch to the home panel (standard sidebar) first, then
 * drive the dialog open; when it closes, return to the originating panel —
 * unless the user navigated elsewhere in the meantime.
 */
function openDshSettings(ctx: ClientContext, source: MessageEventSource | null, origin: string): void {
  const notify = (type: string) => {
    if (source && 'postMessage' in source) (source as Window).postMessage({ type }, origin)
  }
  notify('oss:dsh-settings-accepted')
  // Personal 0.2.8 retains its page in a native modal. Release that modal while
  // the Host owns Settings, then restore the same iframe after Settings closes.
  const resumePersonal = (ctx.get('personal') as PersonalRegistry | undefined)?.suspend?.()
  if (settingsUiMounted()) {
    driveSettingsOpen(ctx, resumePersonal ?? null, notify)
    return
  }
  const layout = ctx.get('layout') as LayoutService | undefined
  if (!layout) { resumePersonal?.(); notify('oss:dsh-settings-failed'); return }
  const previousPanel = layout.panelInfo?.getSnapshot().activePanelId ?? null
  layout.selectPanel(null)
  // Fresh signal: aborted by any later selectPanel, so a user-driven
  // navigation cancels the pending restore below.
  const navigation = layout.beginNavigation?.() ?? null
  driveSettingsOpen(ctx, () => {
    if (navigation?.aborted) { resumePersonal?.(false); return }
    try {
      layout.selectPanel(previousPanel)
    } catch {
      // Panel unregistered meanwhile (e.g. Personal unloaded); stay put.
    }
    resumePersonal?.()
  }, notify)
}

/**
 * Drive the settings dialog through its real open/close lifecycle:
 * wait out whichever dialog owns the layer (the onboarding key prompt is
 * dismiss-ignored — it cannot and need not be closed by us), dispatch
 * `settings.open` once the layer is free, and finish when the dialog the
 * user finally sees closes. `finish` (restore) is only meaningful after a
 * navigation; in-place callers pass null.
 */
function driveSettingsOpen(ctx: ClientContext, finish: (() => void) | null, notify: (type: string) => void): void {
  let finished = false
  let opened = false
  let needDispatch = true
  let waited = 0
  const done = () => {
    if (finished) return
    finished = true
    window.clearInterval(timer)
    window.clearTimeout(deadline)
    finish?.()
    if (!opened) notify('oss:dsh-settings-failed')
  }
  const timer = window.setInterval(() => {
    waited += 250
    if (settingsModalOpen()) {
      if (!opened) notify('oss:dsh-settings-opened')
      opened = true
      return
    }
    if (opened) {
      done()
      return
    }
    // Another dialog owns the layer — let the user finish that flow first,
    // then re-arm the dispatch (a blocked dispatch must be retried).
    if (otherDialogOpen()) {
      needDispatch = true
      waited = 0
      return
    }
    if (needDispatch && waited >= 400) {
      needDispatch = !activateSettingsControl(ctx)
    }
    // Dispatch produced nothing and the layer is empty — don't strand the user.
    if (waited >= 10_000) done()
  }, 250)
  const deadline = window.setTimeout(done, 600_000)
  ctx.effect(() => done)
}

let pageDestination: string | undefined
const pageListeners = new Set<() => void>()
function SlidesPage() {
  const destination = React.useSyncExternalStore(
    listener => { pageListeners.add(listener); return () => { pageListeners.delete(listener) } },
    () => pageDestination,
  )
  return (
    <iframe
      title="DSH SlideStudio"
      src={destination ?? `/app/hub.html?lang=${currentLang}`}
      style={{ display: 'block', width: '100%', height: '100%', minHeight: '80vh', border: 0 }}
    />
  )
}

function SlidesEntryIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M8 11.5v2" />
      <path d="M5.5 14h5" />
    </svg>
  )
}

const PANEL = 'slides'

/** Public composer takeover: accidental Work entry remains readable, with no
 * prompt box that can bypass the editor's project/intent checks. */
function registerSessionEntry(ctx: ClientContext): void {
  ctx.inject(['sessions'], inner => {
    const sessions = inner.get('sessions') as SessionsService
    const ReadOnlyComposer = ({ matched }: { matched: string }) => {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const english = currentLang === 'en'
      const open = async () => {
        setBusy(true); setError('')
        try {
          const response = await fetch(`/slides/state/${encodeURIComponent(matched)}`)
          const state = await response.json() as Partial<SliceSessionSnapshot> & { error?: string }
          if (!response.ok || !state.binding?.projectRoot) throw new Error(state.error || (english ? 'Deck unavailable' : '找不到对应的演示文稿'))
          const query = new URLSearchParams({ project: state.binding.projectRoot, session: matched, workspace: '1', live: '1', lang: currentLang })
          pageDestination = `/app/index.html?${query}`
          pageListeners.forEach(listener => listener())
          const personal = ctx.get('personal') as PersonalRegistry | undefined
          if (!personal?.open?.(PANEL)) (ctx.get('layout') as LayoutService | undefined)?.selectPanel(PANEL)
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
        finally { setBusy(false) }
      }
      return <section aria-label={english ? 'SlideStudio generation history' : '演示文稿生成记录'}
        style={{ padding: '16px 20px', border: '1px solid var(--dsw-alias-border-l3, #ddd)', borderRadius: 12, background: 'var(--dsw-alias-button-elevated-fill, #fff)', color: 'var(--dsw-alias-label-primary, #222)' }}>
        <strong>{english ? 'Continue editing in SlideStudio' : '请在演示文稿中继续编辑'}</strong>
        <p style={{ margin: '8px 0 12px', fontSize: 13 }}>{english ? 'This conversation is the generation history. Open the deck to edit, continue generation or stop it.' : '这里保留生成记录。修改内容、继续生成或停止生成，请打开对应的演示文稿。'}</p>
        <button type="button" disabled={busy} onClick={() => { void open() }}
          style={{ font: 'inherit', padding: '8px 14px', border: '1px solid var(--dsw-alias-border-l3, #ddd)', borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
          {busy ? (english ? 'Opening…' : '正在打开…') : (english ? 'Open in SlideStudio' : '在演示文稿中继续')}
        </button>
        {error && <p role="alert">{error}</p>}
      </section>
    }
    inner.slots.inject('conversation.composer', () => {
      let remove: (() => void) | undefined
      let signature = ''
      const update = () => {
        const owned = Object.entries(sessions.list.getSnapshot().byId)
          .filter(([, row]) => row.projectionValues?.agentPreset === 'slides').map(([id]) => id).sort()
        const next = JSON.stringify(owned)
        if (next === signature) return
        signature = next
        remove?.()
        const ids = new Set(owned)
        remove = inner.slots.register({ name: 'conversation.composer', priority: -100,
          select: (owner: { sessionId?: string }) => owner.sessionId && ids.has(owner.sessionId) ? owner.sessionId : null,
        }, ReadOnlyComposer as React.ComponentType)
      }
      update()
      const off = sessions.list.subscribe(update)
      return () => { off(); remove?.() }
    })
  })
}

/** Main panels must reserve the official desktop window-chrome strip. */
function StandaloneSlidesPage() {
  return (
    <div style={{ height: '100%', boxSizing: 'border-box', paddingTop: 'var(--dsh-frame-top-clearance, 0px)' }}>
      <SlidesPage />
    </div>
  )
}

/** Standalone mode: 演示文稿 sits in the official sidebar panel list itself. */
function registerStandalone(ctx: ClientContext): () => void {
  const stops = [
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL, order: -9, label: () => slideTitle() },
        SlidesEntryIcon,
      )),
  ]
  return () => {
    for (const stop of stops) stop()
  }
}

export function apply(ctx: ClientContext) {
  currentLang = activeLang(ctx)
  // Keep a fallback main destination for older Personal versions without open().
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, StandaloneSlidesPage))
  registerSessionEntry(ctx)
  // Plugin-scope listener: the hub asks to open DSH settings, which may unmount
  // the Personal page (and this page's own effect) mid-flow.
  ctx.effect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.type !== 'oss:open-dsh-settings') return
      openDshSettings(ctx, event.source, event.origin)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  })
  // Follow the DSH Language setting: retitle the Personal entry and notify
  // live iframes so hub/editor copy switches without a reload.
  ctx.effect(() => {
    const locale = ctx.get('locale') as LocaleService | undefined
    if (!locale) return () => {}
    return locale.subscribe(() => {
      const next = activeLang(ctx)
      if (next === currentLang) return
      currentLang = next
      broadcastLang()
    })
  })
  let standalone: (() => void) | undefined = registerStandalone(ctx)
  ctx.inject(['personal'], (inner) => {
    standalone?.()
    standalone = undefined
    const registerFeature = () => inner.personal!.register({
      id: 'slides',
      title: slideTitle(),
      description: slideDescription(),
      order: 1,
      component: SlidesPage,
    })
    let remove = registerFeature()
    const offLocale = (ctx.get('locale') as LocaleService | undefined)?.subscribe(() => {
      // PersonalFeature.title is a static snapshot: re-register to retitle.
      remove()
      remove = registerFeature()
    })
    return () => {
      offLocale?.()
      remove()
      try {
        standalone = registerStandalone(ctx)
      } catch {
        // Own plugin is unloading too; the fiber discards pending effects.
      }
    }
  })
}
