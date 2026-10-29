import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppContext } from '@/hooks/useAppContext';
import { getEnvironmentByRelayUrl } from '@/lib/environments';
import { useAdminApi, useApiUrl } from '@/hooks/useAdminApi';
import { useDivineSession } from '@/hooks/useDivineSession';
import { ApiError } from '@/lib/adminApi';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import type { SexualCase } from '../../shared/sexual-quarantine';

const STATES: Record<SexualCase['state'], string> = {
  review: 'Awaiting review', pending: 'Pending verification', hidden: 'Hidden',
  restored: 'Restored', restored_restricted: 'Restored with remaining restrictions', removed: 'Removed', out_of_scope: 'Outside video scope',
};
const GOALS: Record<SexualCase['goal'], string> = {
  review: 'Review', hide: 'Temporary hide', restore: 'Restore', remove: 'Remove',
};
const time = (at?: number) => at ? new Date(at).toLocaleString() : 'Not recorded';

function Urgency({ item }: { item: SexualCase }) {
  if (item.state === 'out_of_scope' || (item.actor && item.state !== 'pending' && item.decisionRecordedAt)) return null;
  return <Badge variant="destructive">{item.deadlineAt <= Date.now() ? 'Overdue' : 'Urgent review'}</Badge>;
}

export function SexualQuarantine() {
  const { eventId } = useParams();
  const apiUrl = useApiUrl();
  const { config, updateConfig } = useAppContext();
  const sourceRelay = new URLSearchParams(useLocation().search).get('sourceRelay');
  const source = sourceRelay ? getEnvironmentByRelayUrl(sourceRelay) : undefined;
  if (sourceRelay && (sourceRelay !== config.relayUrl || (source && source.apiUrl !== apiUrl))) {
    return <div className="space-y-4">
      <p role="alert">This review link belongs to a different environment. Select its environment before reviewing or deciding.</p>
      {source && <Button onClick={() => updateConfig(c => ({ ...c, relayUrl: source.relayUrl, apiUrl: source.apiUrl }))}>Switch to {source.name}</Button>}
    </div>;
  }
  return <div className="h-full overflow-y-auto space-y-4 pb-4">
    <h2 className="text-xl font-semibold">Sexual content quarantine</h2>
    <p className="text-sm text-muted-foreground">Review reported explicit sexual activity. A requested action remains pending until enforcement is verified.</p>
    {eventId ? <CaseDetail key={`${apiUrl}:${eventId}`} eventId={eventId} /> : <CaseList />}
  </div>;
}

function CaseList() {
  const api = useAdminApi();
  const apiUrl = useApiUrl();
  const cases = useQuery({ queryKey: ['sexual-quarantine', apiUrl], queryFn: api.getSexualQuarantineCases, refetchInterval: 15_000 });
  return <>
    <Button variant="outline" onClick={() => void cases.refetch()} disabled={cases.isFetching}>Refresh cases</Button>
    {cases.isLoading && <p role="status">Loading cases…</p>}
    {cases.isError && <p role="alert">Could not load cases. Refresh to retry.</p>}
    {cases.data && <p className="text-sm text-muted-foreground">Showing up to 100 open cases, earliest deadline first.</p>}
    {cases.data?.cases.length === 0 && <p>No quarantine cases.</p>}
    {cases.data?.cases.map(item => <Card key={item.eventId} className="p-4 space-y-2">
      <div className="flex flex-wrap gap-2"><Urgency item={item} /><Badge variant="secondary">{STATES[item.state]}</Badge></div>
      <Link className="block font-mono text-sm break-all underline" to={`/sexual-quarantine/${item.eventId}`}>{item.eventId}</Link>
      <p>{item.reporters} distinct reporters · hide threshold {item.threshold}</p>
      <p className="text-sm">Requested outcome: {GOALS[item.goal]} · Review deadline: {time(item.deadlineAt)}</p>
    </Card>)}
  </>;
}

function CaseDetail({ eventId }: { eventId: string }) {
  const api = useAdminApi();
  const apiUrl = useApiUrl();
  const session = useDivineSession();
  const client = useQueryClient();
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const key = ['sexual-quarantine', apiUrl, eventId];
  const item = useQuery({ queryKey: key, queryFn: () => api.getSexualQuarantineCase(eventId), refetchInterval: 15_000 });
  const history = useQuery({ queryKey: [...key, 'history'], queryFn: () => api.getSexualQuarantineHistory(eventId), refetchInterval: 15_000 });
  const decision = useMutation({
    mutationFn: async (choice: 'restore' | 'remove') => {
      const revision = item.data!.revision;
      const explanation = reason.trim();
      const actor = await session.getModeratorPubkey();
      if (!active.current) throw new Error('Environment or case changed. Review again.');
      return api.decideSexualQuarantine(eventId, { revision, decision: choice, actor: actor || 'unattributed', reason: explanation });
    },
    onSuccess: async result => {
      client.setQueryData(key, result);
      if (active.current) {
        setReason('');
        setNotice(result.state === 'pending' || (result.actor && !result.decisionRecordedAt) ? 'Decision saved; verification or Reports recording pending.' : 'Decision recorded; check the verified state below.');
      }
      await client.invalidateQueries({ queryKey: ['sexual-quarantine', apiUrl] });
    },
    onError: async error => {
      if (active.current) setNotice(error instanceof ApiError && error.statusCode === 409
        ? 'Case changed. Check the latest revision and review the case again before deciding.'
        : error.message);
      await client.invalidateQueries({ queryKey: ['sexual-quarantine', apiUrl] });
    },
  });
  const c = item.data;
  return <>
    <div className="flex gap-4 items-center"><Link to="/sexual-quarantine" className="underline">All cases</Link>
      <Button variant="outline" onClick={() => void client.invalidateQueries({ queryKey: key })} disabled={item.isFetching}>Refresh case</Button></div>
    {item.isLoading && <p role="status">Loading case…</p>}
    {item.isError && <p role="alert">Could not load this case. Refresh to retry.</p>}
    {notice && <p role="status" className="rounded border p-3">{notice}</p>}
    {c && <Card className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2"><Urgency item={c} /><span className="text-sm">Revision {c.revision}</span></div>
      <p className="font-mono text-sm break-all">{c.eventId}</p>
      <dl className="grid gap-2 sm:grid-cols-2 text-sm">
        <div><dt className="font-semibold">Current state</dt><dd>{STATES[c.state]}</dd></div>
        <div><dt className="font-semibold">Requested outcome</dt><dd>{GOALS[c.goal]}</dd></div>
        <div><dt className="font-semibold">Reports</dt><dd>{c.reporters} distinct reporters · hide threshold {c.threshold}</dd></div>
        <div><dt className="font-semibold">Review deadline</dt><dd>{time(c.deadlineAt)}</dd></div>
        <div><dt className="font-semibold">Created / updated</dt><dd>{time(c.createdAt)} / {time(c.updatedAt)}</dd></div>
        <div><dt className="font-semibold">Last verified</dt><dd>{time(c.verifiedAt)}</dd></div>
        <div><dt className="font-semibold">Attempts / next retry</dt><dd>{c.attempts} / {time(c.retryAt)}</dd></div>
        <div><dt className="font-semibold">Review handoff accepted</dt><dd>{time(c.reviewAcceptedAt)}</dd></div>
        <div><dt className="font-semibold">Human review recorded in Reports</dt><dd>{time(c.decisionRecordedAt)}</dd></div>
        <div><dt className="font-semibold">Escalated</dt><dd>{time(c.escalatedAt)}</dd></div>
      </dl>
      {c.state === 'restored_restricted' && <p>This quarantine hold was released; other restrictions still apply. Public visibility is not restored.</p>}
      {c.actor && !c.decisionRecordedAt && <p>Human decision saved; recording in Reports is pending.</p>}
      {c.lastError && <p role="alert">{c.lastError}</p>}
      <section aria-label="Report provenance" className="space-y-1 text-sm break-all">
        <h3 className="font-semibold">First report</h3>
        <p>Report: {c.firstReport.id}</p><p>Reporter: {c.firstReport.pubkey}</p><p>Category: {c.firstReport.reason}</p>
        {c.actor && <p>Reviewer: {c.actor}</p>}{c.reason && <p>Decision reason: {c.reason}</p>}
      </section>
      <section aria-label="Media review" className="space-y-2">
        <h3 className="font-semibold">Media</h3>
        {!c.snapshot && <p>Media snapshot is not available yet.</p>}
        {c.snapshot?.assets.length === 0 && <p>No reviewable media is mapped in this snapshot.</p>}
        {c.snapshot?.assets.map(hash => <a key={hash} href={`${apiUrl}/media/${hash}`} target="_blank" rel="noopener noreferrer" className="block underline text-sm break-all">Review media {hash}</a>)}
      </section>
      <div className="space-y-2">
        {session.identityUnavailable && <p role="alert">Moderator identity unavailable. Decisions will be attributed as unattributed.</p>}
        <label htmlFor="sexual-decision-reason" className="font-semibold">Decision reason</label>
        <Textarea id="sexual-decision-reason" value={reason} maxLength={2000} disabled={decision.isPending || c.state === 'out_of_scope'} onChange={e => setReason(e.target.value)} />
        <p className="text-sm text-muted-foreground">Restore releases this case’s hold. Remove keeps the event and media unavailable within Divine. Other restrictions remain in force.</p>
        <div className="flex gap-2">{(['restore', 'remove'] as const).map(choice => <Button key={choice} variant={choice === 'remove' ? 'destructive' : 'default'}
          disabled={c.state === 'out_of_scope' || !reason.trim() || decision.isPending || item.isFetching || item.isError} onClick={() => { setNotice(''); decision.mutate(choice); }}>
          {choice === 'restore' ? 'Restore' : 'Remove'}
        </Button>)}</div>
        {decision.isPending && <p role="status">Recording decision…</p>}
      </div>
    </Card>}
    <section aria-label="Case history" className="space-y-2">
      <h3 className="font-semibold">Case history</h3>
      <p className="text-sm text-muted-foreground">Most recent 100 entries, newest first.</p>
      {history.isError && <p role="alert">History unavailable. Refresh to retry.</p>}
      {history.isLoading && <p>Loading history…</p>}
      {history.data?.map((entry, i) => <Card key={i} className="p-3 text-sm break-all">
        <p>{time(entry.at)} · <span>{entry.action}</span>{entry.revision != null && ` · revision ${entry.revision}`}</p>
        {entry.actor && <p>Reviewer: {entry.actor}</p>}{entry.reason && <p>{entry.reason}</p>}
        {entry.id && <p>Report: {entry.id}</p>}{entry.pubkey && <p>Reporter: {entry.pubkey}</p>}
      </Card>)}
    </section>
  </>;
}
