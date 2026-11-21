import { randomUUID } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import yazl from 'yazl';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function batchPrefix(batchId) {
  if (!UUID.test(batchId)) throw new Error('Invalid batch ID');
  return `batches/${batchId}/`;
}

// Partner credentials belong in the database, never in downloadable lead reports.
function archiveInput(input) {
  const { apiConfig = {}, ...lead } = input;
  const secrets = new Set([apiConfig.secretKey, apiConfig.authHeaderValue,
    ...Object.values(apiConfig.customHeaders || {})].filter((value) => typeof value === 'string' && value.length > 0));
  const mask = (value) => {
    let clean = value;
    for (const secret of secrets) clean = clean.replaceAll(secret, '[redacted]');
    return clean;
  };
  const redact = (value, field = '') => {
    if (/secret|token|password|authorization|api.?key/i.test(field)) return '[redacted]';
    if (field === 'url' && typeof value === 'string') {
      try {
        const url = new URL(value);
        for (const key of url.searchParams.keys()) url.searchParams.set(key, '[redacted]');
        return mask(url.href);
      } catch { return '[invalid URL]'; }
    }
    if (typeof value === 'string') return mask(value);
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, key)]));
    return value;
  };
  return redact(lead);
}

export function redactPartnerResponse(value, apiConfig) {
  return archiveInput({ result: value, apiConfig }).result;
}

export async function archiveAndDeliver({ s3, bucket, batchId, input, deliver, transactionId = randomUUID() }) {
  if (!UUID.test(transactionId)) throw new Error('Invalid transaction ID');
  const prefix = `${batchPrefix(batchId)}transactions/${transactionId}/`;
  const requestKey = `${prefix}request.json`;
  try { await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: requestKey,
    Body: JSON.stringify({ recordedAt: new Date().toISOString(), input: archiveInput(input) }),
    ContentType: 'application/json',
    ServerSideEncryption: 'AES256',
  })); } catch (error) {
    error.archiveFailed = 'request';
    throw error;
  }

  let result;
  try {
    result = await deliver();
    return result;
  } catch (error) {
    result = { error: String(error) };
    throw error;
  } finally {
    try { await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${prefix}response.json`,
      Body: JSON.stringify({ recordedAt: new Date().toISOString(), result: redactPartnerResponse(result, input.apiConfig) }),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    })); } catch (error) {
      error.archiveFailed = 'response';
      error.deliveryResult = result;
      throw error;
    }
  }
}

export async function saveSourceFile({ s3, bucket, batchId, filename, body, contentType = 'text/csv' }) {
  const safeName = String(filename || 'source.csv').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const key = `${batchPrefix(batchId)}source/${randomUUID()}-${safeName}`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256',
  }));
  return key;
}

function csvCell(value) {
  const raw = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export async function saveTransactionCsv({ s3, bucket, batchId, transactionId, leadData, result }) {
  const status = result.status === 'Success' ? 'Success' : result.status === 'Duplicate' ? 'Duplicate' : 'Fail';
  const color = status === 'Success' ? 'Green' : status === 'Duplicate' ? 'Red' : 'Light yellow';
  const columns = [...Object.keys(leadData), 'delivery_status', 'status_color', 'partner_response'];
  const values = [...Object.values(leadData), status, color, result.response || ''];
  const body = `${columns.map(csvCell).join(',')}\r\n${values.map(csvCell).join(',')}\r\n`;
  const key = `${batchPrefix(batchId)}transactions/${transactionId}/response.csv`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body,
    ContentType: 'text/csv; charset=utf-8', ServerSideEncryption: 'AES256' }));
  return key;
}

export async function streamBatchZip({ s3, bucket, batchId, output, reportRows, migrationNote }) {
  const prefix = batchPrefix(batchId);
  const zip = new yazl.ZipFile();
  zip.outputStream.on('error', (error) => output.destroy(error));
  zip.outputStream.pipe(output);
  if (reportRows) zip.addReadStreamLazy('report.csv', (done) => done(null, Readable.from(reportRows)));
  if (migrationNote) zip.addBuffer(Buffer.from(migrationNote, 'utf8'), 'MIGRATION-NOTE.txt');

  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken: token,
    }));
    for (const object of page.Contents || []) {
      if (!object.Key || object.Key.endsWith('/')) continue;
      const name = object.Key.slice(prefix.length);
      if (!name || name.split('/').some((part) => part === '..' || part === '')) continue;
      zip.addReadStreamLazy(name, (done) => {
        s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }))
          .then((item) => done(null, item.Body), done);
      });
    }
    token = page.NextContinuationToken;
  } while (token);

  zip.end();
  await finished(output);
}
