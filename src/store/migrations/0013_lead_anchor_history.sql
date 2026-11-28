-- Schema v13 (additive): 0011 held the lead as ambiguous whenever one conversation was bound in more
-- than one folder or runtime. A changed `[lead] cwd` or runtime for the same transcript is normal
-- history: the anchor already is the newest binding. Only one session ID naming different
-- transcripts is ambiguous, and only when it is the anchored ID. That hold now names the kept
-- conversation and the owner's way back to it.
UPDATE lead_anchor SET hold = (
    SELECT 'ambiguous lead binding history: lead session ' || a.session_id
        || ' is recorded with more than one transcript; conversation retained. `cataly lead start` resumes the anchored transcript '
        || a.session_file || ' once it verifies'
    FROM lead_bindings a
    WHERE a.handle = lead_anchor.handle AND EXISTS(
        SELECT 1 FROM lead_bindings o
        WHERE o.session_id = a.session_id AND o.session_file <> a.session_file))
WHERE hold = 'ambiguous lead binding history';
