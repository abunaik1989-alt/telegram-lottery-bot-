import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  BadgeCheck,
  Check,
  ChevronRight,
  Clock3,
  FileCheck2,
  LayoutDashboard,
  Menu,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trophy,
  X,
} from 'lucide-react';
import {
  getGetLotterySummaryQueryKey,
  getListAdminLotteryEntriesQueryKey,
  getListLotteryActivityQueryKey,
  getListLotteryNumbersQueryKey,
  useApproveLotteryEntry,
  useDrawLotteryWinner,
  useGetLotterySummary,
  useListAdminLotteryEntries,
  useListLotteryActivity,
  useListLotteryNumbers,
  useRejectLotteryEntry,
} from '@workspace/api-client-react';
import type { LotteryEntry, LotteryNumber } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  Router as WouterRouter,
  Link,
  useLocation,
} from 'wouter';

const queryClient = new QueryClient();

type ConfirmAction = { kind: 'approve' | 'reject' | 'draw'; entry?: LotteryEntry };

const formatMoney = (value: number, currency: string) =>
  `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)} ${currency}`;

const formatDate = (value?: string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const statusLabel: Record<string, string> = {
  available: 'Available',
  reserved: 'Reserved',
  paid: 'Paid',
  proof_submitted: 'Proof pending',
  rejected: 'Rejected',
};

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const nav = (
    <aside className={`app-sidebar ${mobileOpen ? 'mobile-visible' : ''}`} aria-label="Main navigation">
      <div className="sidebar-brand">
        <div className="flex items-center gap-3">
          <div className="brand-mark">LS</div>
          <div>
            <div className="font-bold tracking-tight">Lotto Service</div>
            <div className="mt-1 text-[10px] font-mono uppercase tracking-[.16em] text-[hsl(var(--sidebar-foreground)/.48)]">Control room</div>
          </div>
        </div>
      </div>
      <nav className="sidebar-nav">
        <div className="nav-label">Operations</div>
        <Link href="/" data-testid="link-dashboard" className={`nav-item ${location === '/' ? 'active' : ''}`} onClick={() => setMobileOpen(false)}>
          <LayoutDashboard size={16} /> <span>Live dashboard</span>
        </Link>
      </nav>
      <div className="sidebar-footer">
        <div className="flex items-center gap-2 text-[hsl(var(--sidebar-foreground)/.75)]"><ShieldCheck size={14} /> Fair draw protocol</div>
        <div className="mt-2">Every approval is logged. Every paid number is visible.</div>
      </div>
    </aside>
  );
  return <div className="lotto-app flex">{mobileOpen ? <div className="fixed inset-0 z-20 bg-[hsl(215_34%_17%/.35)]" onClick={() => setMobileOpen(false)} /> : null}{nav}<div className="main-panel"><header className="topbar"><div className="flex items-center gap-3"><button className="btn btn-ghost mobile-menu" data-testid="button-open-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={17} /></button><div><div className="eyebrow">Saturday draw · Ethiopia</div><h1 className="page-title">Live operations</h1></div></div><div className="flex items-center gap-3"><span className="hidden items-center gap-2 text-xs text-[hsl(var(--muted-foreground))] sm:flex"><span className="h-2 w-2 rounded-full bg-[hsl(var(--primary))]" /> API connected</span><div className="h-8 w-8 rounded-full bg-[hsl(var(--secondary))] grid place-items-center text-xs font-bold">OA</div></div></header>{children}</div></div>;
}

function LoadingPanel() {
  return <div className="panel p-5" aria-label="Loading"><div className="skeleton h-4 w-32" /><div className="mt-5 skeleton h-10 w-20" /><div className="mt-3 skeleton h-3 w-40" /></div>;
}

function ErrorPanel({ onRetry, label = 'Unable to load this section' }: { onRetry: () => void; label?: string }) {
  return <div className="panel empty-state"><AlertCircle className="mx-auto mb-3 text-[hsl(var(--destructive))]" size={22} /><strong>{label}</strong><span>Check the connection and try again.</span><button className="btn btn-ghost mx-auto mt-4" data-testid="button-retry" onClick={onRetry}><RefreshCw size={14} /> Retry</button></div>;
}

function StatCards({ summary, pending }: { summary: any; pending: number }) {
  return <div className="metric-grid grid grid-cols-4 gap-3">
    <div className="panel metric-card reveal"><span className="metric-label">Numbers open</span><strong className="metric-number metric-accent">{summary.availableNumbers}<span className="text-base text-[hsl(var(--muted-foreground))]">/{summary.totalNumbers}</span></strong><div className="metric-foot">{summary.reservedNumbers} reserved · {summary.paidNumbers} paid</div></div>
    <div className="panel metric-card reveal delay-1"><span className="metric-label">Proofs to review</span><strong className={`metric-number ${pending ? 'metric-alert' : 'metric-accent'}`}>{pending}</strong><div className="metric-foot">{pending ? 'Needs a decision today' : 'Queue is clear'}</div></div>
    <div className="panel metric-card reveal delay-2"><span className="metric-label">Collected</span><strong className="metric-number metric-warm">{formatMoney(summary.totalCollected, summary.currency)}</strong><div className="metric-foot">Price per number: {formatMoney(summary.pricePerNumber, summary.currency)}</div></div>
    <div className="panel metric-card reveal delay-3"><span className="metric-label">Draw status</span><strong className="metric-number">{summary.drawCompleted ? `#${summary.winnerNumber}` : 'Not drawn'}</strong><div className="metric-foot">{summary.drawCompleted ? 'Winner locked' : `${summary.paidNumbers} paid entries eligible`}</div></div>
  </div>;
}

function NumberBoard({ numbers, isLoading, isError, onRetry }: { numbers?: LotteryNumber[]; isLoading: boolean; isError: boolean; onRetry: () => void }) {
  const cells = useMemo(() => numbers ?? [], [numbers]);
  return <section className="panel number-board reveal delay-1">
    <div className="section-head"><div><div className="section-title">Number board</div><div className="section-note">One glance. Three clear states.</div></div><span className="mono text-[10px] text-[hsl(var(--muted-foreground))]">01 — 300</span></div>
    {isLoading ? <div className="number-grid">{Array.from({ length: 100 }, (_, i) => <div key={i} className="skeleton aspect-square" />)}</div> : isError ? <ErrorPanel onRetry={onRetry} /> : <div className="number-grid">{cells.map((item) => <div key={item.number} className={`number-cell ${item.status}`} title={item.customerName ? `#${item.number} · ${item.customerName}` : `#${item.number} · ${statusLabel[item.status]}`} data-testid={`status-number-${item.number}`}>{String(item.number).padStart(2, '0')}</div>)}</div>}
    <div className="legend"><span><i className="bg-[hsl(var(--card))] border border-[hsl(var(--border))]" /> Available</span><span><i className="bg-[hsl(40_71%_61%/.35)]" /> Reserved</span><span><i className="bg-[hsl(var(--primary)/.35)]" /> Paid</span></div>
  </section>;
}

function ReviewQueue({ entries, isLoading, isError, onRetry, onAction }: { entries?: LotteryEntry[]; isLoading: boolean; isError: boolean; onRetry: () => void; onAction: (kind: 'approve' | 'reject', entry: LotteryEntry) => void }) {
  const pending = (entries ?? []).filter((entry) => entry.status === 'proof_submitted');
  return <section className="panel review-panel reveal delay-2"><div className="section-head"><div className="section-title"><span className="attention-dot" /> Payment proof review</div><span className="status-chip status-pending">{pending.length} pending</span></div><div className="section-note mb-4">Verify the reference, then confirm or release the number.</div>
    {isLoading ? <div className="space-y-3"><div className="skeleton h-12 w-full" /><div className="skeleton h-12 w-full" /></div> : isError ? <ErrorPanel onRetry={onRetry} /> : pending.length === 0 ? <div className="empty-state px-0"><BadgeCheck className="mx-auto mb-3 text-[hsl(var(--primary))]" size={23} /><strong>All caught up</strong><span>No payment proofs are waiting for review.</span></div> : pending.slice(0, 5).map((entry) => <div className="entry-row" key={entry.id}><div><div className="entry-name"><span className="mono mr-2 text-[hsl(var(--primary))]">#{String(entry.number).padStart(3, '0')}</span>{entry.customerName}</div><div className="entry-detail">{entry.paymentMethod ? entry.paymentMethod.toUpperCase() : 'Payment'} · {entry.paymentReference || 'No reference'} · {formatDate(entry.updatedAt)}</div></div><div className="entry-actions"><button className="btn btn-primary" data-testid={`button-approve-${entry.id}`} onClick={() => onAction('approve', entry)}><Check size={14} /> Approve</button><button className="btn btn-danger" data-testid={`button-reject-${entry.id}`} onClick={() => onAction('reject', entry)}><X size={14} /> Reject</button></div></div>)}
  </section>;
}

function ActivityFeed({ activities, isLoading, isError, onRetry }: { activities?: any[]; isLoading: boolean; isError: boolean; onRetry: () => void }) {
  const iconFor = (type: string) => type === 'approved' ? <Check size={13} /> : type === 'rejected' ? <X size={13} /> : type === 'draw' ? <Trophy size={13} /> : type === 'proof_submitted' ? <FileCheck2 size={13} /> : <Activity size={13} />;
  return <section className="panel activity-list reveal delay-3"><div className="section-head"><div className="section-title">Recent activity</div><span className="section-note">Audit trail</span></div>{isLoading ? <div className="space-y-3"><div className="skeleton h-8 w-full" /><div className="skeleton h-8 w-full" /><div className="skeleton h-8 w-full" /></div> : isError ? <ErrorPanel onRetry={onRetry} /> : !activities?.length ? <div className="empty-state px-0"><Clock3 className="mx-auto mb-3" size={22} /><strong>No activity yet</strong><span>Actions from this draw will appear here.</span></div> : activities.slice(0, 7).map((item) => <div className="activity-item" key={item.id}><div className="activity-icon">{iconFor(item.type)}</div><div><div className="activity-copy">{item.message}</div><div className="activity-time">{formatDate(item.createdAt)}{item.entryNumber ? ` · #${String(item.entryNumber).padStart(3, '0')}` : ''}</div></div></div>)}</section>;
}

function EntriesSection({ entries, isLoading, isError, onRetry, filter, setFilter }: { entries?: LotteryEntry[]; isLoading: boolean; isError: boolean; onRetry: () => void; filter: string; setFilter: (value: string) => void }) {
  const [search, setSearch] = useState('');
  const visible = (entries ?? []).filter((entry) => `${entry.customerName} ${entry.number} ${entry.paymentReference ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="panel mt-4 overflow-hidden reveal delay-4"><div className="p-5 pb-3"><div className="section-head mb-0 toolbar"><div><div className="section-title">Entry register</div><div className="section-note">The complete record behind the board.</div></div><div className="flex items-center gap-2"><div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" /><input className="search-input pl-9" data-testid="input-search-entries" placeholder="Search name, number, reference" value={search} onChange={(event) => setSearch(event.target.value)} /></div><select className="select" data-testid="select-entry-filter" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All entries</option><option value="proof_submitted">Proof pending</option><option value="paid">Paid</option><option value="reserved">Reserved</option><option value="rejected">Rejected</option></select></div></div></div>{isLoading ? <div className="p-5"><div className="skeleton h-36 w-full" /></div> : isError ? <div className="p-5"><ErrorPanel onRetry={onRetry} /></div> : !visible.length ? <div className="empty-state"><Search className="mx-auto mb-3" size={22} /><strong>No matching entries</strong><span>Try another name, number, or status filter.</span></div> : <div className="table-wrap"><table className="entries-table"><thead><tr><th>Number</th><th>Customer</th><th>Payment</th><th>Status</th><th>Updated</th></tr></thead><tbody>{visible.map((entry) => <tr key={entry.id} data-testid={`row-entry-${entry.id}`}><td className="mono font-bold text-[hsl(var(--primary))]">#{String(entry.number).padStart(3, '0')}</td><td><div className="font-bold">{entry.customerName}</div><div className="text-[11px] text-[hsl(var(--muted-foreground))]">{entry.telegramUsername ? `@${entry.telegramUsername.replace(/^@/, '')}` : entry.phone || 'No contact detail'}</div></td><td><div>{entry.paymentMethod ? entry.paymentMethod.toUpperCase() : '—'}</div><div className="text-[11px] text-[hsl(var(--muted-foreground))]">{entry.paymentReference || '—'}</div></td><td><span className={`status-chip ${entry.status === 'paid' ? 'status-paid' : entry.status === 'proof_submitted' ? 'status-pending' : entry.status === 'reserved' ? 'status-reserved' : 'status-available'}`}>{statusLabel[entry.status]}</span></td><td className="text-[hsl(var(--muted-foreground))]">{formatDate(entry.updatedAt)}</td></tr>)}</tbody></table></div>}</section>;
}

function ConfirmModal({ action, onCancel, onConfirm, pending }: { action: ConfirmAction; onCancel: () => void; onConfirm: (reason?: string) => void; pending: boolean }) {
  const [reason, setReason] = useState('');
  const isDraw = action.kind === 'draw';
  const isReject = action.kind === 'reject';
  return <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true"><div className="eyebrow">{isDraw ? 'Final action' : 'Payment proof'}</div><h2 className="modal-title mt-2">{isDraw ? 'Draw the winner?' : `${action.kind === 'approve' ? 'Approve' : 'Reject'} entry #${String(action.entry?.number ?? '').padStart(3, '0')}`}</h2><p className="modal-copy">{isDraw ? 'This selects one winner at random from paid entries and locks the result. The draw cannot be repeated.' : action.kind === 'approve' ? `Confirming ${action.entry?.customerName ?? 'this entry'} marks the payment as verified and includes number #${action.entry?.number} in the final draw.` : 'Rejecting this proof releases the number for someone else. Add a short reason for the audit trail.'}</p>{isReject ? <textarea className="select mt-4 min-h-20 w-full resize-y" data-testid="input-rejection-reason" placeholder="Reason (optional)" value={reason} onChange={(event) => setReason(event.target.value)} /> : null}<div className="modal-actions"><button className="btn btn-ghost" data-testid="button-cancel-confirmation" onClick={onCancel}>Cancel</button><button className={`btn ${isReject ? 'btn-danger' : 'btn-primary'}`} data-testid="button-confirm-action" disabled={pending} onClick={() => onConfirm(reason)}>{pending ? 'Working…' : isDraw ? 'Draw winner' : action.kind === 'approve' ? 'Confirm approval' : 'Confirm rejection'}</button></div></div></div>;
}

function WinnerCard({ summary }: { summary: any }) {
  if (!summary.drawCompleted) return <div className="panel p-5 reveal delay-3"><div className="section-head"><div className="section-title flex items-center gap-2"><Trophy size={17} className="text-[hsl(var(--accent))]" /> Winner state</div><span className="status-chip status-available">Open</span></div><div className="mt-4 flex items-end justify-between gap-4"><div><div className="serif text-3xl italic text-[hsl(var(--foreground))]">A fair draw starts with a clean register.</div><div className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">When every proof is reviewed, draw from the paid entries.</div></div><Sparkles className="mb-1 flex-shrink-0 text-[hsl(var(--accent))]" size={30} /></div></div>;
  return <div className="panel border-[hsl(var(--accent)/.55)] bg-[hsl(var(--accent)/.12)] p-5 reveal delay-3"><div className="section-head"><div className="section-title flex items-center gap-2"><Trophy size={17} className="text-[hsl(31_56%_43%)]" /> Winner locked</div><span className="status-chip status-paid">Completed</span></div><div className="mt-3 flex items-center gap-4"><div className="mono text-5xl font-bold text-[hsl(31_56%_43%)]">#{String(summary.winnerNumber).padStart(3, '0')}</div><div><div className="font-bold">Draw completed</div><div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">Result is recorded in the activity trail.</div></div></div></div>;
}

function Home() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('all');
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [toast, setToast] = useState('');
  const summaryQuery = useGetLotterySummary();
  const numbersQuery = useListLotteryNumbers({ status: 'all' });
  const entriesQuery = useListAdminLotteryEntries({ status: filter as any });
  const activityQuery = useListLotteryActivity();
  const approve = useApproveLotteryEntry();
  const reject = useRejectLotteryEntry();
  const draw = useDrawLotteryWinner();

  const refresh = () => { void queryClient.invalidateQueries({ queryKey: getGetLotterySummaryQueryKey() }); void queryClient.invalidateQueries({ queryKey: getListLotteryNumbersQueryKey({ status: 'all' }) }); void queryClient.invalidateQueries({ queryKey: getListAdminLotteryEntriesQueryKey({ status: filter as any }) }); void queryClient.invalidateQueries({ queryKey: getListLotteryActivityQueryKey() }); };
  const finish = (message: string) => { setConfirm(null); setToast(message); refresh(); window.setTimeout(() => setToast(''), 3600); };
  const execute = (reason?: string) => {
    if (!confirm) return;
    const entry = confirm.entry;
    if (confirm.kind === 'approve' && entry) approve.mutate({ id: entry.id }, { onSuccess: () => finish(`Entry #${entry.number} approved`) });
    if (confirm.kind === 'reject' && entry) reject.mutate({ id: entry.id, data: { reason: reason || null } }, { onSuccess: () => finish(`Entry #${entry.number} rejected and released`) });
    if (confirm.kind === 'draw') draw.mutate(undefined, { onSuccess: (result) => { finish(`Winner drawn: #${result.winnerNumber}`); } });
  };
  const pendingMutation = approve.isPending || reject.isPending || draw.isPending;
  const summary = summaryQuery.data;
  return <Shell><main className="content-wrap">
    {summaryQuery.isLoading ? <div className="grid grid-cols-4 gap-3"><LoadingPanel /><LoadingPanel /><LoadingPanel /><LoadingPanel /></div> : summaryQuery.isError || !summary ? <ErrorPanel onRetry={() => void summaryQuery.refetch()} label="Lottery summary unavailable" /> : <><StatCards summary={summary} pending={summary.proofPending} /><div className="mt-4 grid gap-4 lg:grid-cols-[1.35fr_.85fr]"><NumberBoard numbers={numbersQuery.data} isLoading={numbersQuery.isLoading} isError={numbersQuery.isError} onRetry={() => void numbersQuery.refetch()} /><ReviewQueue entries={entriesQuery.data} isLoading={entriesQuery.isLoading} isError={entriesQuery.isError} onRetry={() => void entriesQuery.refetch()} onAction={(kind, entry) => setConfirm({ kind, entry })} /></div><div className="mt-4 grid gap-4 lg:grid-cols-[1.35fr_.85fr]"><WinnerCard summary={summary} /><ActivityFeed activities={activityQuery.data} isLoading={activityQuery.isLoading} isError={activityQuery.isError} onRetry={() => void activityQuery.refetch()} /></div><EntriesSection entries={entriesQuery.data} isLoading={entriesQuery.isLoading} isError={entriesQuery.isError} onRetry={() => void entriesQuery.refetch()} filter={filter} setFilter={setFilter} /><div className="mt-4 flex flex-col items-start justify-between gap-3 border-t border-[hsl(var(--border))] pt-5 sm:flex-row sm:items-center"><div><div className="text-sm font-bold">Ready to close the register?</div><div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">Only paid entries can win. Review all pending proofs before drawing.</div></div><button className="btn btn-primary" data-testid="button-draw-winner" disabled={summary.drawCompleted || summary.paidNumbers < 1 || summary.proofPending > 0 || draw.isPending} onClick={() => setConfirm({ kind: 'draw' })}><Trophy size={15} /> {summary.drawCompleted ? 'Winner already drawn' : 'Draw winner'} <ChevronRight size={14} /></button></div></>}
  </main>{confirm ? <ConfirmModal action={confirm} onCancel={() => setConfirm(null)} onConfirm={execute} pending={pendingMutation} /> : null}{toast ? <div className="toast-success" role="status" data-testid="status-success"><Check size={14} className="mr-2 inline text-[hsl(var(--accent))]" />{toast}</div> : null}</Shell>;
}

function AdminGate({ children }: { children: ReactNode }) {
  const [key, setKey] = useState(() =>
    window.localStorage.getItem('lotto-admin-key') ?? '',
  );
  const [draft, setDraft] = useState(key);

  if (key) return <>{children}</>;

  return (
    <div className="admin-gate">
      <div className="admin-gate-card panel">
        <div className="brand-mark">LS</div>
        <div className="eyebrow mt-5">Private operations</div>
        <h1 className="page-title mt-2">Enter your admin key</h1>
        <p className="modal-copy">
          This console controls payment approvals and the final winner draw.
          Use the private key you configured for Lotto Service.
        </p>
        <form
          className="mt-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.trim()) return;
            window.localStorage.setItem('lotto-admin-key', draft.trim());
            setKey(draft.trim());
          }}
        >
          <label className="metric-label" htmlFor="admin-key">
            Admin key
          </label>
          <input
            id="admin-key"
            className="search-input mt-2 w-full"
            type="password"
            autoComplete="current-password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Enter your private key"
          />
          <button className="btn btn-primary mt-4 w-full" type="submit">
            Open control room
          </button>
        </form>
      </div>
    </div>
  );
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AdminGate>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
        </AdminGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
