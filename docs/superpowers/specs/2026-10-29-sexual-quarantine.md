# Reversible sexual-video quarantine

The approved goal is to hide reported explicit sexual videos promptly, retain
authorized reviewer access, and provide reliable restoration or removal. Comments,
harassment, behavioural analysis, and account actions are excluded.

Use the existing two-distinct-reporter adult-sexual threshold. A first report
opens an urgent case without hiding. Child-safety categories keep their existing
dedicated path. Broad nudity scores are not explicit-act determinations.

An event case lives in ReportWatcher's durable storage. Before side effects it
records intent, report provenance, revision, deadlines, and a signed video-event
snapshot. Signed URLs and hash tags identify media candidates. Authenticated
metadata must establish eligibility before media actions; reporter-supplied
hashes are never enforcement targets. Unresolved eligibility stays pending and
is retried without changing the original signed evidence.

The media server supplies independent named holds. A hold denies public and owner
access, preserves admin review, and never changes the underlying media status.
Releasing this case's hold cannot release another case or change an unrelated ban,
age restriction, or deletion. No bytes are deleted by this workflow.

Case states distinguish requested actions from verified outcomes. Retryable work
survives eviction and watcher stop. A restore supersedes pending hide work and is
not called complete until public event/media visibility agrees. Human intent is
recorded after accepted scoped commands independently of public verification. Confirmation of
removal retains holds; physical deletion is a separate approved retention action.

Review cases preserve report IDs, original and canonical reasons, timestamps,
evidence provenance, media mapping, attempts, errors, and append-only audit entries.
Overdue cases raise an alert and remain held. COOP acceptance is distinct from
completed human review. All new routes use the existing admin authentication.

Activation is explicitly gated until the media hold API and staging canary pass.
Public-denial checks cover originals, thumbnails, available HLS resources and
variants. Cached browser copies already received cannot be recalled. Live CDN
coverage is a rollout gate, not something mocked integration tests prove.

No paid provider is enabled before a permitted-input, cost, and human-adjudicated
quality evaluation. Existing NSFW evidence remains review-only. Suspected CSAM
must never be submitted to the ordinary adult-content evaluation path.
