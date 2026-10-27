/*
 * Phase 0 probe: paste into the browser console on any logged-in DTMS page.
 * Read-only by construction: the transport it uses refuses to POST.
 * Prints what DTMS Batch would do for the PC Nos. you enter.
 */
(async function () {
  'use strict';
  var core = window.DTMSCore;
  var input = prompt('DTMS probe (read-only)\nPC Nos., each optionally followed by a station code, e.g.\n20261021033 JD00, 20261021037 JE04\n(no code = JD00)', '');
  if (!input) return;
  var parsed = core.parseInput(input.replace(/,\s*(?=20\d{9})/g, '\n'), 'JD00');
  parsed.errors.forEach(function (e) { console.warn('[probe]', e); });

  var http = core.browserHttp();
  var readOnly = { get: http.get, post: function () { throw new Error('probe is read-only'); } };
  var ctx = core.createContext({ http: readOnly, onLog: function (r) { console.log('[probe]', r.pcn, r.step, r.result, r.detail); } });

  try {
    await core.check(ctx, parsed.items);
  } catch (e) {
    console.error('[probe] stopped:', e.message);
    return;
  }

  var rl = core.parseReceiveList(core.parseHtml((await http.get(core.URLS.receiveList)).text));
  console.log('[probe] station:', ctx.station, '| receive list rows:', rl.rows.size, '| live stations:', (ctx.stations || []).length);
  console.table(parsed.items.map(function (it) {
    return {
      pcn: it.pcn, payee: it.info.client, amount: it.info.amount,
      lastLocation: it.info.lastLocation, notYetReceived: it.info.notYetReceived, currentCode: it.info.currentCode,
      inReceiveList: it.inReceiveList, dest: it.dest, plan: it.plan, note: it.message
    };
  }));
  console.log('[probe] Nothing was changed in DTMS. Copy this table into the chat if anything looks wrong.');
})();
