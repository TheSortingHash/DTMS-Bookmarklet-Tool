const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPcns, isPcn, cleanTyped } = require('../src/pcn');

const TODAY = new Date(2026, 9, 28);

test('validates PC Nos.', () => {
  assert.equal(isPcn('20261021037'), true);
  assert.equal(isPcn('20210106040'), true);
  assert.equal(isPcn('20261321037'), false, 'month 13');
  assert.equal(isPcn('2026102103'), false);
  assert.equal(cleanTyped(' 2026 1021-037 '), '20261021037');
});

test('finds the PC No. in OCR text of a DV and ignores the TIN and DV No.', () => {
  // Shape of real OCR output from a phone photo of a printed DV.
  const text = 'No. 26109999 Date: October 27,\n2026\n'
    + 'S No. PP26109999 PC No: 20261027009\n'
    + 'DISTRICT (Not a TIN No: 203-012-150-000\n';
  assert.deepEqual(extractPcns(text, TODAY), ['20261027009']);
});

test('repairs common OCR letter confusions and split digits', () => {
  assert.deepEqual(extractPcns('PC No: 2026l0Z1O37', TODAY), ['20261021037']);
  assert.deepEqual(extractPcns('PC No:\n20261 021037', TODAY), ['20261021037']);
});

test('ranks a labelled candidate above an unlabelled one', () => {
  const text = 'ref 20261001001\nPC No: 20261021037';
  assert.equal(extractPcns(text, TODAY)[0], '20261021037');
});

test('ignores words and drops future-dated numbers', () => {
  assert.deepEqual(extractPcns('Development Academy of the Philippines', TODAY), []);
  assert.deepEqual(extractPcns('20301021037', TODAY), []);
});
