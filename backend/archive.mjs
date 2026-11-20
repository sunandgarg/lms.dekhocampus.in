import { randomUUID } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import yazl from 'yazl';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function batchPrefix(batchId) {
  if (!UUID.test(batchId)) throw new Error('Invalid batch ID');
  return `batches/${batchId}/`;
}

// Partner credentials belong in the database, never in downloadable lead reports.
function archiveInput(input) {
  const { apiConfig, ...lead } = input;
  return lead;
}

export async function archiveAndDeliver({ s3, bucket, batchId, input, deliver, transactionId = randomUUID() }) {
  if (!UUID.test(transactionId)) throw new Error('Invalid transaction ID');
  const prefix = `${batchPrefix(batchId)}transactions/${transactionId}/`;
  const requestKey = `${prefix}request.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: requestKey,
    Body: JSON.stringify({ recordedAt: new Date().toISOString(), input: archiveInput(input) }),
    ContentType: 'application/json',
    ServerSideEncryption: 'AES256',
  }));

  let result;
  try {
    result = await deliver();
    return result;
  } catch (error) {
    result = { error: String(error) };
    throw error;
  } finally {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${prefix}response.json`,
      Body: JSON.stringify({ recordedAt: new Date().toISOString(), result }),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));
  }
}

export async function saveSourceFile({ s3, bucket, batchId, filename, body }) {
  const safeName = String(filename || 'source.csv').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const key = `${batchPrefix(batchId)}source/${safeName}`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: 'text/csv', ServerSideEncryption: 'AES256',
  }));
  return key;
}

export async function streamBatchZip({ s3, bucket, batchId, output }) {
  const prefix = batchPrefix(batchId);
  const zip = new yazl.ZipFile();
  zip.outputStream.on('error', (error) => output.destroy(error));
  zip.outputStream.pipe(output);

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
