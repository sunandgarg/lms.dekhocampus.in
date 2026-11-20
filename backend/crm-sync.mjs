import { randomUUID } from 'node:crypto';
import { executeRecords } from './records.mjs';

export async function syncLeadToCrm(db, lead) {
  if (lead.status !== 'Success' || !lead.mobile) return { imported: 0 };
  const mobile = String(lead.mobile).replace(/\s+/g, '');
  const { data: existing } = await executeRecords(db, { table: 'crm_contacts', select: 'id', single: true,
    filters: [{ field: 'mobile', op: 'eq', value: mobile }] });
  if (existing) {
    await db.execute('INSERT IGNORE INTO lms_crm_mobile (mobile, contact_id) VALUES (?, ?)', [mobile, existing.id]);
    return { imported: 0, skipped: 1 };
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const id = randomUUID();
    const [reserved] = await connection.execute('INSERT IGNORE INTO lms_crm_mobile (mobile, contact_id) VALUES (?, ?)', [mobile, id]);
    if (!reserved.affectedRows) { await connection.rollback(); return { imported: 0, skipped: 1 }; }
    const { data: stage } = await executeRecords(connection, { table: 'pipeline_stages', select: 'id', single: true,
      filters: [{ field: 'is_default', op: 'eq', value: true }] });
    await executeRecords(connection, { table: 'crm_contacts', action: 'insert', values: {
      id, name: lead.name, email: lead.email || null, mobile,
      city: lead.city || null, state: lead.state || null, course: lead.course || null,
      specialization: lead.specialization || null, source: lead.lead_source || 'Lead Push',
      university_id: lead.university_id || null, lead_id: lead.id, stage_id: stage?.id || null,
      priority: 'medium', notes: 'Auto-imported from Lead Push batch',
    } });
    await executeRecords(connection, { table: 'crm_activities', action: 'insert', values: {
      contact_id: id, type: 'system', title: 'Lead Imported',
      description: 'Auto-imported from Lead Push system',
    } });
    await connection.commit();
    return { imported: 1 };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
