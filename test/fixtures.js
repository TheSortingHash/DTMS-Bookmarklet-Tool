// DTMS page templates, trimmed from real pages captured on 2026-10-27.
// The markup around everything the tool reads (header, forms, rows, select,
// the "Oops" block) is kept byte-for-byte; payee names and IDs are made up;
// scripts, styles and the side menu are dropped.

const OPTIONS = [
  ['ACC', 'ACCOUNTING (DVProcess)'], ['JD05', 'Bids and Awards Committee Secretariat'],
  ['JE02', 'Budget Division, Finance'], ['CB00', 'Center for Institutional Marketing'],
  ['JD03', 'Central Documentation and Records Division'], ['BC01', 'Corporate Operations and Strategic Mgt'],
  ['GSD', 'GSD, Admin'], ['JF01', 'Human Resource Mgt &amp; Devt Dept'], ['JD06', 'ICTD, Admin'],
  ['JF02', 'Office of the Director - HRMD'], ['BA00', 'Office of the President &amp; CEO'],
  ['JD00', 'OMD-Administrative Department'], ['JB00', 'OMD-DAP Conference Center'],
  ['JF00', 'OMD-Human Resource Mgt &amp; Devt Dept'], ['SPR', 'OSVP - PROGRAMS'], ['SSO', 'OSVP - SERVICES'],
  ['SSO2', 'OSVPS-Signatory'], ['JE04', 'Pre-Audit'], ['JD01', 'Procurement Unit, Admin'],
  ['RE2', 'REQUESTING OFFICE/UNIT [P]'], ['JD04', 'Services Front Desk'], ['TR3', 'TREASURY (CHK PREP)'],
  ['TRD', 'TREASURY (E-PAID)'], ['TR2', 'TREASURY (SIGNED CHK)'], ['JE03', 'Treasury Division'],
  ['JB01', 'Venue &amp; Accommodation Services'], ['CC00', 'VP-Center for Organizational Devt and Innovation'],
];

const HEADER = `<tr><td colspan="5" height="100"><img src="images/dtms_logo4.png" height="90" width="490"></td></tr>
<tr bgcolor="#2C2C87" height="28">
<td colspan="5" height="21" class="reportHeader21" align="left">&nbsp;<i>Welcome: <b>USER</b> * Station: <b>OMD-Finance Department</b></i>
</td>
</tr>`;

const FOOTER = `<tr bgcolor="#2C2C87" height="35"><td class="repliModule11" height="25" colspan="5" align="center">DTMS Version 1.9 ï¿½ 2018 Development Academy of the Philippines All rights reserved</td></tr>`;

function page(task, body) {
  return `<html><head><title>DTMSystem</title></head><body>
<div id="ToolTip" style="position:absolute; visibility:hidden"></div>
<form method="POST">
<!--<input type="hidden" name="iSearch" value="">-->
<input type="hidden" name="task" value="${task}">
<input type="hidden" name="iSelecttype" value="">
<input type="hidden" name="act" value="">
<input type="hidden" name="ipart" value="">
<input type="hidden" name="code[]" value="">
<table width="100%" cellspacing="0" cellpadding="0" bgcolor="#FFFFFF" border="0">
<tbody>${HEADER}
<tr>
<td width="100%" class="mnu" valign="top" align="center">
${body}
</td>
</tr>
${FOOTER}
</tbody></table>
</form></body></html>`;
}

// rows: [{ pcn, payee, amount }]
function receiveListPage(rows) {
  const trs = rows.map((r, i) => `<tr>
	<td class="qryText3" align="center" height="15">${i + 1}</td>
	<td align="center"><input type="checkbox" name="act[${i + 1}]" value="A"></td>
	<td class="mnu4" align="center">${r.pcn}</td>
	<td class="mnu4" align="center"></td>
	<td class="qryText" align="center">ACCTNG (DVProcess)</td>
	<td class="mnu" align="center">2026-10-27</td>
	<td class="qryText" align="center">OAR</td>
	<td class="qryText" align="left">OTHER PAYMENTS (NON SUPPLIERS / CONTRACTORS)</td>
	<td class="qryText" align="left">${r.payee || 'DELA CRUZ, JUAN A.'}</td>
	<td class="qryText" align="center">100001</td>
	<td class="qryText" align="left">[Reimb of communication expenses] [August 2026]</td>
	<td class="qryText" align="center">${r.amount || '300.00'}</td>
	<!--<td class="qryText" align="center"></td>-->
	</tr>`).join('\n');
  return page(41, `
<br><center class="reportTitle">Documents Received by <font color="#A52A2A">OMD-Finance Department</font> as of October 27, 2026</center><br>
<table align="center" border="1" cellpadding="2" cellspacing="1" width="95%">
<tbody><tr bgcolor="6868C3" height="25">
	<td class="repliModule11" align="center" width="2%" height="20">n</td>
	<td class="repliModule11" align="center" width="4%" height="20">ACK</td>
	<td class="repliModule11" align="center" width="8%">PC No.</td>
	<td class="repliModule11" align="center" width="10%">DTS No.</td>
	<td class="repliModule11" align="center" width="8%" height="20">Received From</td>
	<td class="repliModule11" align="center" width="7%" height="20">Date Received</td>
	<td class="repliModule11" align="center" width="5%">Center</td>
	<td class="repliModule11" align="center" width="14%">Transaction Type</td>
	<td class="repliModule11" align="center" width="16%">Payee Name</td>
	<td class="repliModule11" align="center" width="5%">HRIS No.</td>
	<td class="repliModule11" align="center" width="24%">Particulars</td>
	<td class="repliModule11" align="center" width="8%">Amount</td>
</tr>
${trs}
<tr><td align="center" colspan="12" height="20"><hr size="2" width="93%" color="#4863A0"></td></tr>
<tr><td class="mnuTitlered" align="left" colspan="12"><input type="checkbox" onchange="checkAll(this)" name="chk[]">Select ALL</td></tr>
<tr><td class="modTitle1" align="center" colspan="12" height="35">*Acknowledged Receipt of Checked or Selected Documents ===&gt; <input type="submit" name="iReceive" value="YES!"></td></tr>
</tbody></table>`);
}

// rec: { pcn, client, amount, lastLocation, notYetReceived, currentCode, currentLabel }
// oops: the second <p> of the error block, e.g. "Documents were not yet received by OMD-Finance Signatory!"
function updatePage({ ipcn = '', rec = null, oops = null } = {}) {
  const options = OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  const record = rec ? `
<input type="hidden" name="refind" value="">
<input type="hidden" name="status" value="B">
			<tr><td align="left">
				<table width="100%" cellspacing="1" cellpadding="4" border="0">
					<tbody><tr><td class="reportHeader1" colspan="2" align="center">Processing Control Number:&nbsp;&nbsp;&nbsp;${rec.pcn}</td></tr>
					<tr><td class="reportHeader" width="25%">Client Name:</td><td align="left" class="reportHeader">${rec.client}</td></tr>
					<tr><td align="left" class="reportHeader" width="25%">Transaction Type:</td><td align="left" class="reportHeader">OTHER PAYMENTS (NON SUPPLIERS / CONTRACTORS)</td></tr>
		<!--<tr><td align="left" class="reportHeader" width="25%">Document:</td><td align="left" class="reportHeader"></td></tr>-->
					<tr><td align="left" class="reportHeader" width="25%">Amount:</td><td align="left" class="reportHeader">${rec.amount}</td></tr>
					<tr><td align="left" class="reportHeader" width="5%">Particulars:</td><td align="left" class="mnuTitle">[Reimb of EME] [July to October 2026]</td></tr>
					<tr><td align="left" class="reportHeader" width="25%">Last Location:</td><td align="left" class="reportHeader">${rec.lastLocation}${rec.notYetReceived ? ' (Not yet Received)' : ''}</td></tr>
					<tr><td align="left" class="reportHeader" width="25%">Date / Time:</td><td align="left" class="reportHeader">2026-10-27 / 4:56 pm</td></tr>
					<tr><td align="left" class="reportHeader5" colspan="2">Forwarded to:&nbsp;&nbsp;<select name="ilocate">${options}<option value="" selected="">--------------------</option><option value="${rec.currentCode}" selected="">${rec.currentLabel || rec.lastLocation}</option></select>
</td></tr>
					<tr><td align="center" class="reportHeader" colspan="2">
<input type="checkbox" name="close" value="NULL"> Check box to CLOSE Transaction</td></tr>
					<tr><td align="center" class="reportHeader" colspan="2"><font color="#A52A2A"><u>Indicate reason/s for Transactions forwarded Back to Requestor:</u></font><u>
									<br><br><textarea name="reason" value="" cols="44" rows="1" maxlength="100"></textarea></u></td></tr>
					<tr><td colspan="2" align="center"><input type="submit" name="iUpdate" value="Update Location">&nbsp;&nbsp;<input type="submit" name="cancel" value="Never Mind"></td></tr>
				</tbody></table></td></tr>` : '';
  const right = oops ? `<tbody><tr>
		<td><p align="left" style="font-family: Verdana; font-size: 14.5pt; font-weight: bold; color: #CC3366">Oops....</p>
					<p align="left" style="font-family: Verdana; font-size: 13pt; font-weight: bold; color: #3366CC">${oops}</p>


			<p align="left" style="font-family: Arial; font-size: 10pt; font-weight: normal; color: #000000">
					Process cannot proceed unless the above problem has been resolved!<br><br>
					Please consult your System Administrator, if you need assistance.</p>
		</td>
	</tr>
			</tbody>` : `<tbody><tr><td colspan="2"><img src="images/DAP3D4.png" border="0" height="550" width="580"></td></tr>
			</tbody>`;
  return page(3, `<table border="0" width="98%" align="center" cellpadding="0" cellspacing="0">
	<tbody><tr>
		<td width="45%" align="center">
			<table border="0" width="100%" align="center">
			<tbody><tr><td align="center" class="mnuA81">**Update Transaction Location**</td></tr>
			<tr><td><hr color="#6FA6DE" size="2" width="100%"></td></tr>
			<tr><td align="center" class="reportTitle" height="30">Enter Processing Control Number:&nbsp;&nbsp;&nbsp;
						<input type="text" name="ipcn" value="${ipcn}" size="12" maxlength="11">&nbsp;&nbsp;&nbsp;
						<input type="submit" name="iSearch" value="Search"></td></tr>
			<tr><td align="left" class="mnuTitle"><hr color="#6868C3" size="6" width="100%"></td></tr>${record}
			</tbody></table></td>
		<td width="3%"><table><tbody><tr><td>&nbsp;</td></tr></tbody></table></td>
		<td width="42%" align="center">
			<table border="0" cellpadding="0" cellspacing="0" width="100%" align="center" valign="top">
			${right}</table></td>
	</tr>
</tbody></table>`);
}

function loginPage() {
  return `<html><head>
<title>DTMS User Registry</title>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
</head>
<body>
<table width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF">
<tbody><tr><td colspan="5" height="100"><img src="images/dtms_logo4.png" height="90" width="490"></td></tr>
</tbody></table>
<form method="POST">
	<hr color="#2C2C87" size="26">
<table bgcolor="#E6F5F5" border="2" align="center" width="40%" height="250" bordercolor="#2C5E91"><tbody><tr><td>
<table bgcolor="#E6F5F5" width="98%" valign="top" align="center" cellpadding="6" cellspacing="0" border="0">
	<tbody><tr><td align="center"><font size="3" color="#2C2C87"><b> <font color="RED">RCA</font> DTMS User Sign-in</b></font></td></tr>
	<tr><td align="center"><font color="black" size="2">Please Enter your User Name and Password.</font></td></tr>
	<tr><td align="center">
		<table border="1" align="center" bgcolor="#E6F5F5" cellpadding="5" cellspacing="1">
			<tbody><tr><td width="90" height="22" align="right"><font face="Verdana" size="-1"><b>User Name:<b></b></b></font></td>
				<td><input type="text" name="username" value="" size="20" maxlength="50"></td></tr>
			<tr><td width="90" height="22" align="right"><font face="Verdana" size="-1"><b>Password:<b></b></b></font></td>
				<td><input type="password" name="password" value="" size="20" maxlength="15"></td></tr>
			<tr><td align="center" colspan="2"> <input type="submit" name="submit" value="Enter">&nbsp;&nbsp;&nbsp;
				<input type="submit" value="Clear" name="reset"></td></tr>
		</tbody></table>
	</td></tr>
</tbody></table>
</td></tr>
</tbody></table>
</form>
</body></html>`;
}

module.exports = { receiveListPage, updatePage, loginPage, OPTIONS };
