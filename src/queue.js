/*
 * DTMS queue client: talks to the Apps Script web app (apps-script/Code.gs).
 * Every call is a POST with a text/plain JSON body (a "simple" request, so no
 * CORS preflight). Apps Script answers with a redirect to googleusercontent.com,
 * which fetch follows and which allows any origin.
 */
(function (root) {
  'use strict';

  function createQueueClient(url, token, fetchImpl) {
    var doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(root) : null);

    async function call(op, payload) {
      var res;
      try {
        res = await doFetch(url, {
          method: 'POST', redirect: 'follow', credentials: 'omit', cache: 'no-store',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(Object.assign({ op: op, token: token }, payload || {}))
        });
      } catch (e) {
        throw new Error('Could not reach the queue web app (' + (e && e.message || e) + '). Check the URL in Settings.');
      }
      if (!res.ok) throw new Error('Queue web app answered HTTP ' + res.status);
      var text = await res.text(), data;
      try { data = JSON.parse(text); } catch (e) {
        throw new Error('Queue web app did not return JSON. Is it deployed with "Who has access: Anyone"?');
      }
      if (!data.ok) throw new Error('Queue: ' + data.error);
      return data;
    }

    return {
      ping: function () { return call('ping'); },
      pending: function (batchId) { return call('pending', { batchId: batchId || '' }); },
      enqueue: function (items) { return call('enqueue', { items: items }); },
      report: function (report) { return call('report', report); },
      setStations: function (stations) { return call('setStations', { stations: stations }); }
    };
  }

  // What the Sheet gets after a run: statuses and the action log, never payee or amount.
  function buildReport(station, items, logRows) {
    return {
      station: station || '',
      // Desk-typed items that never started stay out of the Sheet.
      results: items.filter(function (it) { return it.queueId || it.status !== 'PENDING'; }).map(function (it) {
        return {
          id: it.queueId || '', batchId: it.batchId || '', pcn: it.pcn, destCode: it.dest,
          status: it.status, message: it.message || '', attempts: it.attempts || 0
        };
      }),
      log: (logRows || []).map(function (r) {
        return { ts: r.ts, station: r.station, pcn: r.pcn, step: r.step, result: r.result, detail: r.detail };
      })
    };
  }

  var api = { createQueueClient: createQueueClient, buildReport: buildReport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DTMSQueue = api;
})(typeof window !== 'undefined' ? window : this);
