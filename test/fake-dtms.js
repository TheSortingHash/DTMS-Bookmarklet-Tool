// A stateful stand-in for DTMS, serving pages from fixtures.js.
// Models the behaviour observed on 2026-10-27:
//  - task=41 lists records forwarded to our station (JE05) and not yet received;
//  - "Update Location" refuses with "Oops" while the record is not yet received
//    at its current location;
//  - after a successful update, the page shows the new location "(Not yet Received)".

const { receiveListPage, updatePage, loginPage, OPTIONS } = require('./fixtures');

const LABELS = Object.fromEntries(OPTIONS.map(([c, l]) => [c, l.replace(/&amp;/g, '&')]));
LABELS.JE05 = 'OMD-Finance Signatory';
const MY_CODE = 'JE05';

function createFakeDtms(records, { expireAfter = Infinity } = {}) {
  const db = new Map(records.map(r => [r.pcn, { received: true, client: 'BAUTISTA, JOSE C.', amount: '4,311.85', ...r }]));
  const posts = [];
  let count = 0;

  function listRows() {
    return [...db.values()].filter(r => r.loc === MY_CODE && !r.received)
      .map(r => ({ pcn: r.pcn, payee: r.client, amount: r.amount }));
  }

  function recPage(r, oops) {
    return updatePage({
      ipcn: r.pcn,
      rec: {
        pcn: r.pcn, client: r.client, amount: r.amount,
        lastLocation: LABELS[r.loc], notYetReceived: !r.received,
        currentCode: r.loc, currentLabel: LABELS[r.loc]
      },
      oops
    });
  }

  function handle(method, url, params) {
    if (++count > expireAfter) return loginPage();
    const u = new URL(url, 'http://192.168.1.220');
    const task = u.searchParams.get('task') || (params && params.get('task'));

    if (task === '41') {
      if (method === 'POST' && params.get('iReceive') === 'YES!') {
        const rows = listRows();
        for (const [k, v] of params) {
          const m = k.match(/^act\[(\d+)\]$/);
          if (m && v === 'A') db.get(rows[Number(m[1]) - 1].pcn).received = true;
        }
      }
      return receiveListPage(listRows());
    }

    if (task === '3') {
      const pcn = method === 'GET' ? u.searchParams.get('ipcn') : params.get('ipcn');
      const r = db.get(pcn);
      if (!r) return updatePage({ ipcn: pcn });
      if (method === 'POST' && params.get('iUpdate')) {
        if (!r.received) return recPage(r, `Documents were not yet received by ${LABELS[r.loc]}!`);
        r.loc = params.get('ilocate');
        r.received = false;
      }
      return recPage(r);
    }
    throw new Error('Unexpected request ' + method + ' ' + url);
  }

  const http = {
    async get(url) { return { url, text: handle('GET', url) }; },
    async post(url, params) {
      posts.push({ url, body: params.toString() });
      return { url, text: handle('POST', url, params) };
    }
  };
  return { http, db, posts, handle };
}

module.exports = { createFakeDtms, LABELS };
