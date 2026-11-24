import { randomUUID } from 'node:crypto';
import { isAdmin } from './access.mjs';

function fail(status, message) { throw Object.assign(new Error(message), { status }); }

export function validateSourceProposal(input) {
  const clean = (key) => {
    if (typeof input?.[key] !== 'string') fail(400, `${key} must be text`);
    const value = input[key].trim();
    if (value.length > (key === 'note' ? 2000 : 200)) fail(400, `${key} is too long`);
    return value;
  };
  const proposal = Object.fromEntries(['source', 'medium', 'proposed_source', 'proposed_medium', 'note']
    .map((key) => [key, clean(key)]));
  if (!proposal.source) fail(400, 'Choose an incoming source');
  if (!proposal.proposed_source && !proposal.proposed_medium && !proposal.note) fail(400, 'Enter a source, medium, or note');
  return proposal;
}

export function upsertSourceRule(rules, proposal) {
  const match = { source: proposal.source, medium: proposal.medium, campaign: '' };
  const set = { source: proposal.proposed_source, medium: proposal.proposed_medium, campaign: '' };
  if (!set.source && !set.medium) return rules;
  const existing = rules.findIndex((rule) => rule.match?.source?.toLowerCase() === match.source.toLowerCase() &&
    String(rule.match?.medium || '').toLowerCase() === match.medium.toLowerCase() && !rule.match?.campaign);
  const rule = { id: existing >= 0 ? rules[existing].id : randomUUID(), enabled: true, match, set };
  return existing < 0 ? [rule, ...rules] : rules.map((item, index) => index === existing ? rule : item);
}

async function approve(db, id, actor) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM lms_source_reviews WHERE id = ? FOR UPDATE', [id]);
    const proposal = rows[0];
    if (!proposal) fail(404, 'Source note not found');
    if (proposal.status !== 'pending') fail(409, 'This source note was already reviewed');
    if (proposal.proposed_source || proposal.proposed_medium) {
      const [settings] = await connection.execute(`SELECT id, data FROM lms_records WHERE collection = 'app_settings'
        AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.key')) = 'lead_attribution_rules' LIMIT 1 FOR UPDATE`);
      let rules = [];
      if (settings.length) {
        const data = typeof settings[0].data === 'string' ? JSON.parse(settings[0].data) : settings[0].data;
        try { rules = JSON.parse(data.value); } catch { rules = []; }
        if (!Array.isArray(rules)) rules = [];
        data.value = JSON.stringify(upsertSourceRule(rules, proposal));
        await connection.execute('UPDATE lms_records SET data = ? WHERE collection = ? AND id = ?',
          [JSON.stringify(data), 'app_settings', settings[0].id]);
      } else {
        await connection.execute('INSERT INTO lms_records (collection, id, data) VALUES (?, ?, ?)',
          ['app_settings', randomUUID(), JSON.stringify({ key: 'lead_attribution_rules',
            value: JSON.stringify(upsertSourceRule([], proposal)) })]);
      }
    }
    await connection.execute("UPDATE lms_source_reviews SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(3) WHERE id = ?",
      [actor.id, id]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function sourceReview(db, user, input) {
  const action = input?.action;
  if (action === 'list') {
    const [sources] = await db.execute(`SELECT
      JSON_UNQUOTE(JSON_EXTRACT(data, '$.source')) AS source,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data, '$.extra_data.attribution_medium')), '') AS medium,
      COUNT(*) AS leads,
      COUNT(DISTINCT NULLIF(JSON_UNQUOTE(JSON_EXTRACT(data, '$.campaign')), '')) AS campaigns,
      GROUP_CONCAT(DISTINCT NULLIF(JSON_UNQUOTE(JSON_EXTRACT(data, '$.campaign')), '')
        ORDER BY JSON_UNQUOTE(JSON_EXTRACT(data, '$.campaign')) SEPARATOR ' · ') AS campaign_names,
      GROUP_CONCAT(DISTINCT NULLIF(JSON_UNQUOTE(JSON_EXTRACT(data, '$.connection_name')), '')
        ORDER BY JSON_UNQUOTE(JSON_EXTRACT(data, '$.connection_name')) SEPARATOR ', ') AS connections
      FROM lms_records WHERE collection = 'inbound_leads'
        AND JSON_EXTRACT(data, '$.deleted_at') IS NULL
      GROUP BY source, medium ORDER BY leads DESC, source LIMIT 500`);
    const [reviews] = await db.execute(`SELECT r.id, r.source, r.medium, r.proposed_source, r.proposed_medium,
      r.note, r.status, r.created_at, r.reviewed_at, u.email AS author
      FROM lms_source_reviews r JOIN lms_users u ON u.id = r.user_id
      ${isAdmin(user) ? '' : 'WHERE r.user_id = ?'}
      ORDER BY r.created_at DESC LIMIT 200`, isAdmin(user) ? [] : [user.id]);
    return { sources, reviews };
  }
  if (action === 'submit' || action === 'publish') {
    if (action === 'publish' && !isAdmin(user)) fail(403, 'Admin approval required');
    const proposal = validateSourceProposal(input);
    const id = randomUUID();
    await db.execute(`INSERT INTO lms_source_reviews
      (id, source, medium, proposed_source, proposed_medium, note, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, proposal.source, proposal.medium,
      proposal.proposed_source, proposal.proposed_medium, proposal.note, user.id]);
    if (action === 'publish') await approve(db, id, user);
    return { id, status: action === 'publish' ? 'approved' : 'pending' };
  }
  if (action === 'approve' || action === 'reject') {
    if (!isAdmin(user)) fail(403, 'Admin approval required');
    if (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.id)) fail(400, 'Invalid source note');
    if (action === 'approve') await approve(db, input.id, user);
    else {
      const [result] = await db.execute(`UPDATE lms_source_reviews SET status = 'rejected',
        reviewed_by = ?, reviewed_at = NOW(3) WHERE id = ? AND status = 'pending'`, [user.id, input.id]);
      if (!result.affectedRows) fail(409, 'This source note was already reviewed or does not exist');
    }
    return { id: input.id, status: action === 'approve' ? 'approved' : 'rejected' };
  }
  fail(400, 'Unknown source action');
}
