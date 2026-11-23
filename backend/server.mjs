import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { S3Client } from '@aws-sdk/client-s3';
import { saveSourceFile, streamBatchZip } from './archive.mjs';
import { clearSessionCookie, createSession, sessionCookie, sessionUser, signOut, verifyPassword } from './auth.mjs';
import { executeRecords } from './records.mjs';
import { processLead, processLeadBatch } from './lead-processor.mjs';
import { resolveShortUrl } from './redirect.mjs';
import { manageUsers } from './admin-users.mjs';
import { receiveLead } from './inbound.mjs';
import { createGenericConnection, listGenericConnections, receiveGenericLead, updateGenericConnection } from './generic-inbound.mjs';
import { processQueue, serverIp, verifyDomain } from './misc-functions.mjs';
import { canUpload, isAdmin, requireOwnedBatch, userRecords } from './access.mjs';
import { hideLeads } from './lead-visibility.mjs';
import { batchReport } from './report.mjs';
import { universityDeliveryReport } from './university-delivery-report.mjs';
import { maskContactData } from './mask-contact.mjs';
import { testApi, testCustomIntegration } from './test-integrations.mjs';
import { exportData, importData } from './db-transfer.mjs';
import { aiGateway } from './ai.mjs';
import { handleAdWebhook, verifyMeta } from './ad-webhooks.mjs';
import { receiveEmailEvents } from './email-webhook.mjs';
import { authorizeShortApi, shortAnalytics, shorten } from './short-api.mjs';
import { retryInboundDelivery, retryLeads, runAutoRetries } from './retry.mjs';
import { enqueueLeads, sealQueue, workQueue, recoverQueue, controlBatch, activateScheduledBatches } from './queue.mjs';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const loginAttempts = new Map();

function send(response, status, data, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(JSON.stringify(data));
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Request body is too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(body) {
  try { return JSON.parse(body.toString('utf8')); }
  catch {
    const error = new Error('Invalid JSON');
    error.status = 400;
    throw error;
  }
}

async function readJson(request) { return parseJson(await readBody(request, MAX_JSON_BYTES)); }

function clientUser(user) {
  return {
    id: user.id,
    email: user.email,
    user_metadata: { full_name: user.full_name },
    role: user.role,
    is_approved: Boolean(user.is_approved),
  };
}

function sameOrigin(request, host) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === host; }
  catch { return false; }
}

function checkRateLimit(address) {
  const now = Date.now();
  const attempts = (loginAttempts.get(address) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (attempts.length >= 10) return false;
  attempts.push(now);
  loginAttempts.set(address, attempts);
  if (loginAttempts.size > 10000) {
    for (const [key, list] of loginAttempts) {
      if (list.every((time) => now - time >= 15 * 60 * 1000)) loginAttempts.delete(key);
    }
  }
  return true;
}

function requireAdmin(user) {
  if (!isAdmin(user)) {
    const error = new Error('Admin access required');
    error.status = 403;
    throw error;
  }
}

function checkBatchId(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '')) {
    const error = new Error('Invalid batch ID');
    error.status = 400;
    throw error;
  }
}

export function makeHandler({ db, s3, bucket, secureCookies = true, host = 'lms.dekhocampus.com' }) {
  return async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}`);
      const method = request.method || 'GET';
      if (url.pathname === '/api/health' && method === 'GET') {
        await db.query('SELECT 1');
        return send(response, 200, { ok: true });
      }
      if (url.pathname === '/api/redirect/resolve' && method === 'GET') {
        const target = await resolveShortUrl(db, {
          code: url.searchParams.get('code'), header: url.searchParams.get('header'),
          userAgent: request.headers['user-agent'], referrer: request.headers.referer,
          ip: request.socket.remoteAddress,
        });
        return target ? send(response, 200, { original_url: target }) : send(response, 404, { error: 'Short URL not found' });
      }
      if (url.pathname === '/api/shorten' && method === 'POST') {
        const key = await authorizeShortApi(db, request.headers.authorization, 'create');
        return send(response, 200, await shorten(db, key, await readJson(request), host));
      }
      const analytics = /^\/api\/analytics\/([A-Za-z0-9]{3,64})$/.exec(url.pathname);
      if (analytics && method === 'GET') {
        const key = await authorizeShortApi(db, request.headers.authorization, 'read');
        return send(response, 200, await shortAnalytics(db, key, analytics[1]));
      }
      if (url.pathname === '/api/inbound/lead' && method === 'OPTIONS') {
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '3600' });
        return response.end();
      }
      if (url.pathname === '/api/inbound/lead' && method === 'POST') {
        const authorization = request.headers.authorization || '';
        const bearerKey = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
        const payload = await readJson(request);
        const result = await receiveLead({ db, s3, bucket, payload, bearerKey });
        return send(response, 200, result, { 'Access-Control-Allow-Origin': '*' });
      }
      if (url.pathname === '/api/inbound/generic-lead' && method === 'POST') {
        const authorization = String(request.headers.authorization || '');
        const token = authorization.replace(/^Bearer\s+/i, '');
        return send(response, 202, await receiveGenericLead({ db, s3, bucket, token,
          payload: await readJson(request), idempotencyKey: request.headers['idempotency-key'] }));
      }
      if (url.pathname === '/api/webhooks/meta-ads-webhook' && method === 'GET') {
        if (url.searchParams.get('hub.mode') !== 'subscribe') return send(response, 400, { error: 'Invalid verification mode' });
        const challenge = await verifyMeta(db, url.searchParams.get('hub.verify_token'), url.searchParams.get('hub.challenge'));
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return response.end(challenge);
      }
      const adWebhook = /^\/api\/webhooks\/(meta|google)-ads-webhook$/.exec(url.pathname);
      if (adWebhook && method === 'POST') {
        const rawBody = await readBody(request, MAX_JSON_BYTES);
        const result = await handleAdWebhook({ db, s3, bucket,
          platform: adWebhook[1] === 'meta' ? 'facebook' : 'google',
          key: url.searchParams.get('key'), payload: parseJson(rawBody), rawBody,
          signature: request.headers['x-hub-signature-256'] });
        return send(response, 200, result);
      }
      if (url.pathname === '/api/webhooks/netcore-email-webhook' && method === 'POST') {
        return send(response, 200, await receiveEmailEvents(db, url.searchParams.get('key'), await readJson(request)));
      }
      if (method !== 'GET' && !sameOrigin(request, host)) return send(response, 403, { error: 'Invalid request origin' });
      if (url.pathname === '/api/auth/login' && method === 'POST') {
        const remote = request.socket.remoteAddress || '';
        const forwarded = request.headers['x-real-ip'];
        const address = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && isIP(forwarded)
          ? forwarded : remote || 'unknown';
        if (!checkRateLimit(address)) return send(response, 429, { error: 'Too many login attempts' });
        const { email, password } = await readJson(request);
        const [rows] = await db.execute('SELECT * FROM lms_users WHERE email = ? LIMIT 1', [String(email || '').trim().toLowerCase()]);
        const user = rows[0];
        if (!user || !await verifyPassword(String(password || ''), user.password_hash) || !user.is_approved) {
          return send(response, 401, { error: 'Invalid email or password' });
        }
        const token = await createSession(db, user.id);
        await db.execute('UPDATE lms_users SET last_sign_in_at = NOW(3) WHERE id = ?', [user.id]);
        return send(response, 200, { user: clientUser(user) }, { 'Set-Cookie': sessionCookie(token, secureCookies) });
      }
      if (url.pathname === '/api/auth/logout' && method === 'POST') {
        await signOut(db, request);
        return send(response, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(secureCookies) });
      }

      const user = await sessionUser(db, request);
      if (!user || !user.is_approved) return send(response, 401, { error: 'Sign in required' });
      if (url.pathname === '/api/auth/me' && method === 'GET') return send(response, 200, { user: clientUser(user) });

      if (url.pathname === '/api/functions/university-delivery-report' && method === 'POST') {
        return send(response, 200, await universityDeliveryReport(db, await readJson(request)));
      }

      if (url.pathname === '/api/functions/all-leads-excluded-batches' && method === 'POST') {
        await readJson(request);
        const { data } = await executeRecords(db, { table: 'upload_batches', select: 'id,file_name',
          order: [{ field: 'created_at', ascending: false }], limit: 1000 });
        return send(response, 200, { ids: data.filter((batch) =>
          !/^(API_|facebook_ads_|google_ads_|bing_ads_|LandingPage:)/i.test(batch.file_name || '')).map((batch) => batch.id) });
      }
      if (url.pathname === '/api/functions/all-leads-deliveries' && method === 'POST') {
        const ids = (await readJson(request)).lead_ids;
        if (!Array.isArray(ids) || ids.length > 500 || ids.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) {
          return send(response, 400, { error: 'Choose up to 500 valid incoming leads' });
        }
        if (!ids.length) return send(response, 200, { deliveries: {} });
        const { data: leads } = await executeRecords(db, { table: 'inbound_leads', select: 'id,batch_ids',
          filters: [{ field: 'id', op: 'in', value: ids }, { field: 'deleted_at', op: 'is', value: null }], limit: ids.length });
        const batchIds = [...new Set(leads.flatMap((lead) => Array.isArray(lead.batch_ids) ? lead.batch_ids : []))];
        const batches = [];
        for (let offset = 0; offset < batchIds.length; offset += 500) {
          const { data } = await executeRecords(db, { table: 'upload_batches',
            select: '*,universities(name)',
            filters: [{ field: 'id', op: 'in', value: batchIds.slice(offset, offset + 500) }], limit: 500 });
          batches.push(...data.map((batch) => ({ id: batch.id, status: batch.status,
            success_count: batch.success_count, duplicate_count: batch.duplicate_count,
            fail_count: batch.fail_count, error_message: batch.error_message,
            universities: batch.universities })));
        }
        const byId = new Map(batches.map((batch) => [batch.id, batch]));
        const deliveries = Object.fromEntries(leads.map((lead) => [lead.id,
          (lead.batch_ids || []).map((id) => byId.get(id)).filter(Boolean)]));
        return send(response, 200, { deliveries: isAdmin(user) ? deliveries : maskContactData(deliveries) });
      }
      if (url.pathname === '/api/functions/delete-leads' && method === 'POST') {
        requireAdmin(user);
        return send(response, 200, await hideLeads(db, user, (await readJson(request)).lead_ids));
      }

      if (url.pathname === '/api/generic-connections' && method === 'GET') {
        requireAdmin(user);
        return send(response, 200, { connections: await listGenericConnections(db) });
      }
      if (url.pathname === '/api/generic-connections' && method === 'POST') {
        requireAdmin(user);
        return send(response, 201, await createGenericConnection(db, await readJson(request), user.id));
      }
      const genericConnection = /^\/api\/generic-connections\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (genericConnection && method === 'PATCH') {
        requireAdmin(user);
        return send(response, 200, { connection: await updateGenericConnection(db, genericConnection[1], await readJson(request)) });
      }
      const inboundArchive = /^\/api\/inbound\/generic-leads\/([0-9a-f-]{36})\/archive\.zip$/.exec(url.pathname);
      if (inboundArchive && method === 'GET') {
        requireAdmin(user);
        checkBatchId(inboundArchive[1]);
        const { data: lead } = await executeRecords(db, { table: 'inbound_leads', select: 'id',
          filters: [{ field: 'id', op: 'eq', value: inboundArchive[1] }], single: true });
        if (!lead) return send(response, 404, { error: 'Lead not found' });
        response.writeHead(200, { 'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="inbound-lead-${lead.id}.zip"`,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return streamBatchZip({ s3, bucket, batchId: lead.id, output: response });
      }

      if (url.pathname === '/api/db/export' && method === 'GET') {
        requireAdmin(user);
        response.writeHead(200, { 'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="lms-data-${new Date().toISOString().slice(0, 10)}.json"`,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        await new Promise((resolve, reject) => Readable.from(exportData(db)).pipe(response).on('finish', resolve).on('error', reject));
        return;
      }
      if (url.pathname === '/api/functions/db-import-export' && method === 'POST') {
        requireAdmin(user);
        const input = await readJson(request);
        if (input.action !== 'import') return send(response, 400, { error: 'Use the data export download' });
        return send(response, 200, await importData(db, input));
      }

      if (url.pathname === '/api/records' && method === 'POST') {
        const query = await readJson(request);
        return send(response, 200, await userRecords(db, user, query));
      }

      if (url.pathname === '/api/functions/admin-user-management' && method === 'POST') {
        requireAdmin(user);
        return send(response, 200, await manageUsers(db, await readJson(request), user));
      }
      if (url.pathname === '/api/functions/server-ip' && method === 'POST') {
        requireAdmin(user);
        return send(response, 200, await serverIp());
      }
      if (url.pathname === '/api/functions/test-api' && method === 'POST') {
        requireAdmin(user);
        return send(response, 200, await testApi(await readJson(request), { s3, bucket }));
      }
      if (url.pathname === '/api/functions/test-custom-integration' && method === 'POST') {
        requireAdmin(user);
        return send(response, 200, await testCustomIntegration(await readJson(request)));
      }
      if (url.pathname === '/api/functions/ai-gateway' && method === 'POST') {
        requireAdmin(user);
        return send(response, 200, aiGateway(await readJson(request)));
      }
      if (url.pathname === '/api/functions/retry-leads' && method === 'POST') {
        if (!await canUpload(db, user)) return send(response, 403, { error: 'Access denied' });
        const body = await readJson(request);
        const result = await retryLeads({ db, s3, bucket, leadIds: body.lead_ids, userId: user.id });
        return send(response, 200, isAdmin(user) ? result : maskContactData(result));
      }
      if (url.pathname === '/api/functions/retry-inbound-delivery' && method === 'POST') {
        if (!await canUpload(db, user)) return send(response, 403, { error: 'Access denied' });
        const body = await readJson(request);
        const result = await retryInboundDelivery({ db, s3, bucket,
          batchId: body.batch_id, userId: user.id });
        return send(response, 200, isAdmin(user) ? result : maskContactData(result));
      }
      if (url.pathname === '/api/functions/process-queue' && method === 'POST') {
        if (!await canUpload(db, user)) return send(response, 403, { error: 'Access denied' });
        const batchId = (await readJson(request)).batchId;
        if (batchId) await requireOwnedBatch(db, user, batchId);
        else requireAdmin(user);
        return send(response, 200, await processQueue(db, batchId));
      }
      if (url.pathname === '/api/functions/verify-domain' && method === 'POST') {
        requireAdmin(user);
        return send(response, 200, await verifyDomain(db, await readJson(request), user));
      }

      const rpc = /^\/api\/rpc\/([a-z_]+)$/.exec(url.pathname);
      if (rpc && method === 'POST') {
        const args = await readJson(request);
        if (rpc[1] === 'has_role') return send(response, 200, Boolean(args._user_id === user.id && (user.role === args._role || args._role === 'admin' && user.role === 'super_admin')));
        if (rpc[1] === 'is_user_approved') return send(response, 200, Boolean(args._user_id === user.id && user.is_approved));
        if (rpc[1].startsWith('increment_batch_')) {
          requireAdmin(user);
          const field = { increment_batch_success: 'success_count', increment_batch_duplicate: 'duplicate_count', increment_batch_fail: 'fail_count' }[rpc[1]];
          if (!field) return send(response, 404, { error: 'Unknown RPC' });
          const [rows] = await db.execute('SELECT data FROM lms_records WHERE collection = ? AND id = ? LIMIT 1', ['upload_batches', args.batch_uuid]);
          if (!rows.length) return send(response, 404, { error: 'Batch not found' });
          const batch = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
          batch[field] = Number(batch[field] || 0) + 1;
          await db.execute('UPDATE lms_records SET data = ? WHERE collection = ? AND id = ?', [JSON.stringify(batch), 'upload_batches', args.batch_uuid]);
          return send(response, 200, null);
        }
        return send(response, 404, { error: 'Unknown RPC' });
      }

      if (url.pathname === '/api/functions/process-lead' && method === 'POST') {
        if (!await canUpload(db, user)) return send(response, 403, { error: 'Access denied' });
        const body = await readJson(request);
        const tasks = Array.isArray(body.tasks) ? body.tasks : [body];
        for (const task of tasks) await requireOwnedBatch(db, user, task.batchId);
        const result = Array.isArray(body.tasks)
          ? await processLeadBatch({ db, s3, bucket, tasks: body.tasks, concurrency: body.concurrency, userId: user.id })
          : await processLead({ db, s3, bucket, task: body, userId: user.id });
        return send(response, 200, isAdmin(user) ? result : maskContactData(result));
      }

      const source = /^\/api\/batches\/([^/]+)\/source$/.exec(url.pathname);
      if (source && method === 'POST') {
        if (!await canUpload(db, user)) return send(response, 403, { error: 'Access denied' });
        checkBatchId(source[1]);
        await requireOwnedBatch(db, user, source[1]);
        if (!bucket) throw new Error('Archive bucket is not configured');
        const filename = request.headers['x-filename'] || 'source.csv';
        const body = await readBody(request, MAX_FILE_BYTES);
        const key = await saveSourceFile({ s3, bucket, batchId: source[1], filename, body });
        return send(response, 200, { key });
      }

      const queue = /^\/api\/batches\/([^/]+)\/queue$/.exec(url.pathname);
      if (queue && method === 'POST') {
        if (!await canUpload(db, user)) return send(response, 403, { error: 'Access denied' });
        checkBatchId(queue[1]);
        await requireOwnedBatch(db, user, queue[1]);
        const input = await readJson(request);
        return send(response, 200, input.finalize
          ? await sealQueue(db, queue[1]) : await enqueueLeads(db, queue[1], input.tasks));
      }

      const batchControl = /^\/api\/batches\/([^/]+)\/control$/.exec(url.pathname);
      if (batchControl && method === 'POST') {
        if (!await canUpload(db, user)) return send(response, 403, { error: 'Access denied' });
        checkBatchId(batchControl[1]);
        await requireOwnedBatch(db, user, batchControl[1]);
        const { action, discussionWith } = await readJson(request);
        return send(response, 200, await controlBatch(db, batchControl[1], action, discussionWith));
      }

      const responseCsv = /^\/api\/batches\/([^/]+)\/response\.csv$/.exec(url.pathname);
      if (responseCsv && method === 'GET') {
        checkBatchId(responseCsv[1]);
        await requireOwnedBatch(db, user, responseCsv[1]);
        response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="lead-responses-${isAdmin(user) ? 'full' : 'masked'}-${responseCsv[1]}.csv"`,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        for await (const row of batchReport(db, responseCsv[1], { masked: !isAdmin(user) })) response.write(row);
        return response.end();
      }

      const archive = /^\/api\/batches\/([^/]+)\/archive\.zip$/.exec(url.pathname);
      if (archive && method === 'GET') {
        requireAdmin(user);
        checkBatchId(archive[1]);
        await requireOwnedBatch(db, user, archive[1]);
        if (!bucket) throw new Error('Archive bucket is not configured');
        const [batchRows] = await db.execute("SELECT data FROM lms_records WHERE collection = 'upload_batches' AND id = ?", [archive[1]]);
        const batch = batchRows[0]?.data;
        const migrationNote = batch?.historical_import_without_source
          ? 'Historical batch metadata was imported from the November 20, 2026 database backup. The backup contained batch counts, but no original CSV data, lead rows, or transaction files for this batch. The full original backup is retained privately in S3 under migrations/2026-11-20/source-postgres-backup.tar.gz. The included report.csv therefore cannot reconstruct individual historical leads.\n'
          : null;
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="lms-batch-${archive[1]}.zip"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return streamBatchZip({ s3, bucket, batchId: archive[1], output: response,
          reportRows: batchReport(db, archive[1]), migrationNote });
      }

      return send(response, 404, { error: 'Not found' });
    } catch (error) {
      console.error('API request failed:', error);
      if (!response.headersSent) send(response, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
      else response.destroy(error);
    }
  };
}

export async function start() {
  const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'lms',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'lms',
    connectionLimit: 4,
    enableKeepAlive: true,
  });
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  for (const statement of schema.split(';').map((part) => part.trim()).filter(Boolean)) await db.query(statement);
  await recoverQueue(db);
  const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
  const server = createServer(makeHandler({ db, s3, bucket: process.env.ARCHIVE_BUCKET }));
  server.listen(Number(process.env.PORT || 3000), '127.0.0.1');
  const retryTimer = setInterval(() => runAutoRetries({ db, s3, bucket: process.env.ARCHIVE_BUCKET })
    .catch((error) => console.error('Automatic retry scan failed:', error)), 60_000);
  let activeQueueWorkers = 0;
  let lastScheduleScan = 0;
  let scheduleScanBusy = false;
  const queueTimer = setInterval(() => {
    if (!scheduleScanBusy && Date.now() - lastScheduleScan >= 5000) {
      lastScheduleScan = Date.now();
      scheduleScanBusy = true;
      activateScheduledBatches(db).catch((error) => console.error('Schedule scan failed:', error))
        .finally(() => { scheduleScanBusy = false; });
    }
    if (activeQueueWorkers >= 2) return;
    activeQueueWorkers++;
    workQueue({ db, s3, bucket: process.env.ARCHIVE_BUCKET })
      .catch((error) => console.error('Lead queue worker failed:', error))
      .finally(() => { activeQueueWorkers--; });
  }, 100);
  server.on('close', () => { clearInterval(retryTimer); clearInterval(queueTimer); db.end(); });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().catch((error) => { console.error(error); process.exitCode = 1; });
}
