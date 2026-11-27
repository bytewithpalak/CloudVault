const test = require('node:test');
const assert = require('node:assert');
const { cleanName, cleanFolder, previewType, disposition } = require('../lib/files');
const { checkEmail } = require('../lib/email');
const rateLimit = require('../lib/rate-limit');

test('file names', () => {
  assert.equal(cleanName('  report.pdf '), 'report.pdf');
  for (const bad of ['', '..', 'a/b', 'a\b', 'a\nb', 'x'.repeat(201), 5]) assert.equal(cleanName(bad), null);
});

test('folder paths', () => {
  assert.equal(cleanFolder(undefined), '/');
  assert.equal(cleanFolder('notes/'), '/notes');
  assert.equal(cleanFolder('//a//b'), '/a/b');
  assert.equal(cleanFolder('/a/../b'), null);
});

test('previews never serve uploaded markup as a page', () => {
  assert.equal(previewType('a.PDF').kind, 'pdf');
  assert.match(previewType('a.html').mime, /^text\/plain/);
  assert.match(previewType('a.svg').mime, /^text\/plain/);
  assert.equal(previewType('a.zip'), null);
  assert.equal(previewType('a.constructor'), null);
});

test('download header handles quotes and other languages', () => {
  const header = disposition('attachment', 'रिपोर्ट "final".pdf');
  assert.match(header, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''[A-Za-z0-9%._~!*-]+$/);
});

test('badly formed emails are rejected', async () => {
  for (const bad of ['', 'abc', 'a@b', 'a@@gmail.com', 'a b@gmail.com', 'a..b@gmail.com', 'x@gmial.com']) {
    assert.ok((await checkEmail(bad)).error, bad);
  }
});

test('rate limit blocks after the maximum', () => {
  const limit = rateLimit({ max: 2, windowMs: 1000 });
  limit.hit('a');
  assert.ok(limit.allow('a'));
  limit.hit('a');
  assert.ok(!limit.allow('a'));
  limit.reset('a');
  assert.ok(limit.allow('a'));
});
