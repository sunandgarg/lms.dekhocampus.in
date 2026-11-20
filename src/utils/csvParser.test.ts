import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCSV } from './csvParser.ts';

test('lead CSV keeps quoted commas, newlines, and escaped quotes in one row', () => {
  const parsed = parseCSV('name,email,mobile,address\r\n"A, B",a@example.com,9999999999,"First line\r\nSecond ""line"""\r\n');
  assert.equal(parsed.data.length, 1);
  assert.equal(parsed.data[0].name, 'A, B');
  assert.equal(parsed.data[0].address, 'First line\r\nSecond "line"');
});

test('lead CSV rejects an unclosed quoted value', () => {
  assert.throws(() => parseCSV('name,email\n"Alice,a@example.com'), /unclosed quoted field/);
});
