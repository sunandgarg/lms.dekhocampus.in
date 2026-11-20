import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { archiveAndDeliver, saveSourceFile, streamBatchZip } from './archive.mjs';

const batchId = '5fcce38a-97ba-4f97-a457-d8ab5fd73173';

test('lead input is saved before delivery without partner credentials', async () => {
  const writes = [];
  const s3 = { send: async (command) => { writes.push(command.input); return {}; } };
  const result = await archiveAndDeliver({
    s3, bucket: 'archive', batchId,
    input: { leadData: { phone: '123' }, apiConfig: { secretKey: 'private' },
      outbound: { url: 'https://partner.example/leads?key=private', headers: { Authorization: 'Bearer private' },
        body: { name: 'Alice', secret_key: 'private' } } },
    deliver: async () => { assert.equal(writes.length, 1); return { status: 'Success' }; },
  });
  assert.deepEqual(result, { status: 'Success' });
  assert.equal(writes.length, 2);
  assert.doesNotMatch(writes[0].Body, /private/);
  assert.match(writes[0].Body, /Alice/);
  assert.match(writes[1].Body, /Success/);
});

test('delivery does not start when request archive fails', async () => {
  let delivered = false;
  await assert.rejects(archiveAndDeliver({
    s3: { send: async () => { throw new Error('S3 unavailable'); } },
    bucket: 'archive', batchId, input: {},
    deliver: async () => { delivered = true; },
  }), /S3 unavailable/);
  assert.equal(delivered, false);
});

test('failed delivery is archived as a failure', async () => {
  const writes = [];
  await assert.rejects(archiveAndDeliver({
    s3: { send: async (command) => { writes.push(command.input); return {}; } },
    bucket: 'archive', batchId, input: { leadData: { phone: '123' } },
    deliver: async () => { throw new Error('Partner timeout'); },
  }), /Partner timeout/);
  assert.equal(writes.length, 2);
  assert.match(writes[1].Body, /Partner timeout/);
});

test('source files use a safe batch-scoped key', async () => {
  let saved;
  const key = await saveSourceFile({
    s3: { send: async (command) => { saved = command.input; } },
    bucket: 'archive', batchId, filename: '../leads.csv', body: Buffer.from('name\nA'),
  });
  assert.match(key, new RegExp(`^batches/${batchId}/source/[0-9a-f-]{36}-\\.\\._leads\\.csv$`));
  assert.equal(saved.Body.toString(), 'name\nA');
});

test('batch ZIP can be regenerated from saved S3 objects', async () => {
  const output = new PassThrough();
  const bytes = buffer(output);
  const s3 = { send: async (command) => {
    if (command instanceof ListObjectsV2Command) return {
      Contents: [{ Key: `batches/${batchId}/source/leads.csv` }],
    };
    if (command instanceof GetObjectCommand) return { Body: Readable.from(['name\nA']) };
    throw new Error('Unexpected S3 command');
  } };
  await streamBatchZip({ s3, bucket: 'archive', batchId, output });
  const zip = await bytes;
  assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304');
  assert.match(zip.toString(), /source\/leads.csv/);
});
