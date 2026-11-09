import { AudioLines, Gauge, Layers, LayoutDashboard, Moon, Network, Radio, Sun, Timer } from 'lucide-react'
import { Suspense, lazy, useEffect, useState, type ComponentType } from 'react'
import { Badge, cx } from './components/ui'
import { api } from './lib/api'
import { useSession } from './lib/session'
import LiveAgent from './pages/LiveAgent'
import Overview from './pages/Overview'

const TurnLab = lazy(() => import('./pages/TurnLab'))
const TransportLab = lazy(() => import('./pages/TransportLab'))
const LatencyLab = lazy(() => import('./pages/LatencyLab'))
const ArchitectureLab = lazy(() => import('./pages/ArchitectureLab'))
const LiveKitPage = lazy(() => import('./pages/LiveKitPage'))

const ROUTES: { id: string; label: string; icon: typeof Gauge; group: string; lesson?: string; el: ComponentType }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, group: '', el: Overview },
  { id: 'live', label: 'Live Agent', icon: AudioLines, group: 'Build', lesson: 'L1 · L3 · L4 · L5', el: LiveAgent },
  { id: 'turn', label: 'Turn-taking Lab', icon: Timer, group: 'Labs', lesson: 'L3', el: TurnLab },
  { id: 'transport', label: 'Transport Lab', icon: Network, group: 'Labs', lesson: 'L2', el: TransportLab },
  { id: 'latency', label: 'Latency Lab', icon: Gauge, group: 'Labs', lesson: 'L1 · L5', el: LatencyLab },
  { id: 'architecture', label: 'Architecture Lab', icon: Layers, group: 'Labs', lesson: 'L1 · L4', el: ArchitectureLab },
  { id: 'livekit', label: 'LiveKit', icon: Radio, group: 'Production', lesson: 'L1 · L3 · L4 · L5', el: LiveKitPage },
]

function useHash() {
  const [h, setH] = useState(() => location.hash.replace('#/', '') || 'overview')
  useEffect(() => { const f = () => setH(location.hash.replace('#/', '') || 'overview'); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f) }, [])
  return h
}

function useTheme(): [string, () => void] {
  const [t, setT] = useState(() => localStorage.getItem('voicelab.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  useEffect(() => { document.documentElement.dataset.theme = t; localStorage.setItem('voicelab.theme', t) }, [t])
  return [t, () => setT(t === 'dark' ? 'light' : 'dark')]
}

export default function App() {
  const route = useHash()
  const [theme, toggle] = useTheme()
  const [up, setUp] = useState<boolean | null>(null)
  const status = useSession((s) => s.status)
  const agent = useSession((s) => s.agentState)
  useEffect(() => {
    let alive = true
    const ping = () => api.health().then(() => alive && setUp(true)).catch(() => alive && setUp(false))
    ping(); const id = setInterval(ping, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  const current = ROUTES.find((r) => r.id === route) ?? ROUTES[0]
  const Page = current.el
  let lastGroup = '__'
  return (
    <div className="flex h-full">
      <nav className="hidden w-[212px] shrink-0 flex-col border-r border-line bg-surface md:flex" aria-label="Primary">
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="8" fill="var(--accent)" /><g fill="#fff"><rect x="6" y="13" width="3" height="6" rx="1.5" /><rect x="11" y="9" width="3" height="14" rx="1.5" /><rect x="16" y="5" width="3" height="22" rx="1.5" /><rect x="21" y="10" width="3" height="12" rx="1.5" /><rect x="26" y="14" width="2" height="4" rx="1" /></g></svg>
          <span className="text-[15px] font-semibold tracking-tight">VoiceLab</span>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {ROUTES.map((r) => {
            const header = r.group !== lastGroup && r.group
            lastGroup = r.group
            const Icon = r.icon
            const active = r.id === current.id
            return (
              <div key={r.id}>
                {header && <div className="px-2.5 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-fg3">{r.group}</div>}
                <a href={`#/${r.id}`} className={cx('group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors', active ? 'bg-accent/12 text-accent' : 'text-fg2 hover:bg-inset hover:text-fg')} aria-current={active ? 'page' : undefined}>
                  <Icon size={16} />
                  <span className="flex-1">{r.label}</span>
                  {r.id === 'live' && status === 'live' && <span className="h-2 w-2 rounded-full bg-good" title="session live" />}
                </a>
              </div>
            )
          })}
        </div>
        <div className="border-t border-line p-3 text-[11px] leading-snug text-fg3">Companion lab for <i>Building AI Voice Agents for Production</i> (DeepLearning.AI × LiveKit).</div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
          <div className="flex gap-1 md:hidden">{ROUTES.map((r) => <a key={r.id} href={`#/${r.id}`} className={cx('rounded-md p-1.5', r.id === current.id ? 'bg-accent/15 text-accent' : 'text-fg3')} title={r.label}><r.icon size={16} /></a>)}</div>
          <div className="hidden text-[13px] font-semibold md:block">{current.label}</div>
          {current.lesson && <span className="hidden rounded-md border border-line px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fg3 md:inline">{current.lesson}</span>}
          <div className="ml-auto flex items-center gap-2">
            {status === 'live' && route !== 'live' && <a href="#/live"><Badge tone="good" className="pulse">session live · agent {agent}</Badge></a>}
            <Badge tone={up === null ? 'neutral' : up ? 'good' : 'bad'}>{up === null ? 'checking backend…' : up ? 'backend online' : 'backend offline'}</Badge>
            <button onClick={toggle} aria-label="Toggle theme" className="rounded-lg p-1.5 text-fg2 hover:bg-inset">{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-4">
          {up === false && (
            <div className="mb-4 rounded-xl border border-bad/40 bg-bad/10 p-3 text-[13px] text-bad">
              The VoiceLab backend isn’t reachable. Start it with <code className="rounded bg-inset px-1.5 py-0.5 font-mono text-fg">make dev</code> (or <code className="rounded bg-inset px-1.5 py-0.5 font-mono text-fg">./scripts/start.sh</code>) from the project root.
            </div>
          )}
          <Suspense fallback={<div className="p-8 text-sm text-fg3">Loading…</div>}><Page /></Suspense>
        </main>
      </div>
    </div>
  )
}
