/**
 * The owner's Telegram bot, set up in three steps (ADR-047): paste the token
 * BotFather gave you, Caprock checks it with Telegram, then a one-time code
 * pairs the chat. The first private chat to send the code is the only one
 * the bot listens to — which replaces the old "open getUpdates in a browser
 * and copy chat.id", a step that asked the reader to read raw JSON.
 *
 * Shared by the weekly report and the phone alerts, which send through the
 * same bot (ADR-024, ADR-036). The alerts are free and the report is not, so
 * the setup cannot live only behind the report's lock.
 *
 * The token is write-only. It goes in, it is never sent back; the screen
 * shows a mask of its last four characters and the bot's @name, which is how
 * a person tells two bots apart.
 */
import { useEffect, useRef, useState } from 'react'
import { api, errText, type Settings, type TelegramStatus } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { useNow } from '@/lib/useNow'

export function TelegramBotFields({ onSaved }: { s?: Settings; onSaved: () => void }) {
  const tg = useApi(() => api.telegram(), [], { live: false })
  const [state, setState] = useState<TelegramStatus | undefined>(undefined)
  const [token, setToken] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const now = useNow(1000)
  const saved = useRef(onSaved)
  useEffect(() => {
    saved.current = onSaved
  })

  useEffect(() => {
    if (tg.data) setState(tg.data)
  }, [tg.data])

  // While a code waits, ask every two seconds whether it has been sent: the
  // moment the chat pairs, the screen says so.
  const pairing = state?.pairing
  useEffect(() => {
    if (!pairing) return
    const t = window.setInterval(() => {
      void api.telegram().then((st) => {
        setState(st)
        if (st.chat_set && !st.pairing) saved.current()
      }).catch(() => {})
    }, 2000)
    return () => window.clearInterval(t)
  }, [pairing])

  if (tg.error && !state) {
    return <p className="text-[11px] text-danger">Could not read the Telegram setup: {tg.error.message}</p>
  }
  if (!state) return null

  const run = async (f: () => Promise<TelegramStatus>) => {
    setBusy(true)
    setError('')
    try {
      const st = await f()
      setState(st)
      onSaved()
      return st
    } catch (e) {
      // Telegram's own words: "does not recognise this token" is something
      // only the reader can fix.
      setError(errText(e))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const saveToken = async () => {
    const st = await run(() => api.telegramToken(token.trim()))
    if (!st) return
    setToken('')
    setEditing(false)
    // Straight on to pairing: a token with no chat sends nothing anywhere.
    if (!st.chat_set) await run(() => api.telegramPair())
  }

  const err = error && <p className="text-[11px] text-danger">{error}</p>
  const bot = state.bot_username ? `@${state.bot_username}` : 'your bot'

  if (!state.bot_set || editing) {
    return (
      <div className="grid gap-2">
        <p className="text-fg">
          <span className="mono text-fg-muted">1</span> · Make a bot
        </p>
        <p className="text-[12px] leading-relaxed text-fg-muted">
          In Telegram, message <span className="mono">@BotFather</span>, send <span className="mono">/newbot</span>, pick a
          name, and paste the token it gives you. Your own bot, so messages go straight from this computer to Telegram —
          never through anybody's server.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input min-w-0 flex-1"
            type="password"
            aria-label="Bot token"
            placeholder="123456:ABC-DEF…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && token.trim()) void saveToken()
            }}
          />
          <button
            onClick={() => void saveToken()}
            disabled={busy || !token.trim()}
            className="rounded-sm border border-accent bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25 disabled:opacity-50"
          >
            {busy ? 'checking…' : 'Check and save'}
          </button>
          {editing && (
            <button onClick={() => setEditing(false)} className="text-[12px] text-fg-muted hover:text-fg">
              Cancel
            </button>
          )}
        </div>
        <p className="text-[11px] text-fg-faint">
          Caprock asks Telegram whether the token is real before keeping it, stores it on this computer only, and never
          shows it again.
        </p>
        {err}
      </div>
    )
  }

  const botLine = (
    <p className="flex flex-wrap items-baseline gap-x-2 text-fg">
      <span>{bot}</span>
      <span className="mono text-[11px] text-fg-faint">{state.token_masked}</span>
      <button onClick={() => setEditing(true)} className="text-[12px] text-fg-muted hover:text-fg">
        Change bot
      </button>
    </p>
  )

  if (pairing) {
    const left = Math.max(0, Math.round((pairing.expires_ms - now) / 1000))
    return (
      <div className="grid gap-2">
        {botLine}
        <p className="text-fg">
          <span className="mono text-fg-muted">2</span> · Pair your chat
        </p>
        <p className="text-[12px] leading-relaxed text-fg-muted">
          Open {bot} in Telegram and send it this code. The first private chat that sends it becomes the only one the bot
          listens to.
        </p>
        <p className="flex flex-wrap items-center gap-3">
          <span className="mono text-[26px] font-semibold tracking-[0.18em] text-fg" aria-label="Pairing code">
            {pairing.code}
          </span>
          {pairing.link && (
            <a
              href={pairing.link}
              target="_blank"
              rel="noreferrer"
              className="rounded-sm border border-accent bg-accent/15 px-3 py-1 text-[12px] text-accent hover:bg-accent/25"
            >
              Open {bot} and send it
            </a>
          )}
        </p>
        <p className="text-[11px] text-fg-faint">
          Or type <span className="mono">/start {pairing.code}</span> to {bot}. Waiting… {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : 'expired'}
          {' · '}
          <button onClick={() => void run(() => api.telegramCancelPair())} className="text-fg-muted hover:text-fg">
            Cancel
          </button>
        </p>
        {state.last_error && <p className="text-[11px] text-danger">Telegram: {state.last_error}</p>}
        {err}
      </div>
    )
  }

  return (
    <div className="grid gap-2">
      {botLine}
      {state.chat_set ? (
        <p className="text-[12px] text-fg-muted">
          {state.manual_chat ? (
            <>Sends to a chat id typed in by hand. Pair again to have the chat named here.</>
          ) : (
            <>
              Paired with <span className="text-fg">{state.chat_name || 'your chat'}</span>. Messages from any other chat are
              ignored.
            </>
          )}
        </p>
      ) : (
        <p className="text-[12px] text-fg-muted">No chat yet: pair one so the bot knows where to write.</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void run(() => api.telegramPair())}
          disabled={busy}
          className="rounded-sm border border-border px-3 py-1 text-[12px] hover:border-fg-faint disabled:opacity-50"
        >
          {state.chat_set ? 'Pair again' : 'Pair a chat'}
        </button>
        <button
          onClick={() => void run(() => api.telegramDisconnect())}
          disabled={busy}
          className="text-[12px] text-fg-muted hover:text-danger disabled:opacity-50"
        >
          Disconnect
        </button>
      </div>
      {state.last_error && <p className="text-[11px] text-danger">Telegram: {state.last_error}</p>}
      {err}
    </div>
  )
}
