const axios = require('axios');
const Excel = require('exceljs');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// Configuration
const API_KEY = process.env.API_KEY;
const BATCH_SIZE = 400;
const REQUEST_RATE = 4;
const DELAY_BETWEEN_BATCHES = 400 / REQUEST_RATE;

// API Endpoints
const BEES_URL = 'https://view-staging.decklar.com/services/v2/bees';
const STATUS_BASE_URL = 'https://view-staging.decklar.com/services/v2/autocrud/bee_commands';
const SEND_URL = 'https://view-staging.decklar.com/services/command/send_commands';

// Account Profiles
const ACCOUNT_PROFILES = {
 PQE_Testing: {
 deviceType: 'BSFlex',
 ping_frequency: 600,
 accountName: 'PQE_Testing',
 profileCommand: 'AT+TIMEGAP=0,600,1,600 & AT+SAMPLEMODE=0,0'
 }
};

class DeviceConfigAutomation {
 constructor() {
 this.results = [];
 this.commandAnalysis = {};
 }

 cleanImei(imei) {
 if (typeof imei !== 'string') {
 imei = String(imei);
 }
 imei = imei.replace(/\D/g, '');
 return imei.length >= 12 ? imei : null;
 }

 getEpochTime(date) {
 return Math.floor(date.getTime() / 1000);
 }

 formatDate(date) {
 return date.toISOString().replace('T', ' ').substring(0, 19);
 }

 delay(ms) {
 return new Promise(resolve => setTimeout(resolve, ms));
 }

 async makeRequest(config, retries = 3) {
 for (let i = 0; i < retries; i++) {
 try {
 const response = await axios(config);
 return response;
 } catch (error) {
 console.error(`Request attempt ${i + 1} failed:`, error.message);
 if (i === retries - 1) throw error;
 await this.delay(1000 * (i + 1));
 }
 }
 }

 async getDevicesForAccount(account) {
 const now = new Date();
 const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
 
 console.log(`DEBUG: 48-hour filter cutoff: ${this.formatDate(fortyEightHoursAgo)}`);
 
 const filter = `device_type eq '${account.deviceType}' and active eq '1' and account_name eq '${account.accountName}'`;
 
 const params = {
 '$raw': JSON.stringify({
 query: {bool: {must: [], must_not: []}},
 aggs: {
 zoom1: {geohash_grid: {field: "last_known_geo", precision: 1}},
 on_asset: {filter: {bool: {must_not: [{terms: {"asset_name.keyword": ["unallocated"]}}], must: [{exists: {field: "asset_uuid"}}]}}},
 on_shipment: {filter: {bool: {must_not: [{terms: {"shipment_name.keyword": ["unallocated"]}}], must: [{exists: {field: "shipment_name"}}]}}},
 nocomm: {filter: {terms: {"communication.keyword": ["NONTWK", "NOCOMM"]}}},
 battery_status_low: {filter: {terms: {"battery_state.keyword": ["Low", "Drained"]}}}
 }
 }),
 '$filter': filter,
 '$offset': 0,
 '$size': 1000,
 '$fields': 'all'
 };

 try {
 const response = await this.makeRequest({
 method: 'GET',
 url: BEES_URL,
 params: params,
 headers: {
 'Content-Type': 'application/json',
 'apikey': API_KEY
 },
 timeout: 30000
 });

 const fortyEightHoursAgoEpoch = this.getEpochTime(fortyEightHoursAgo);
 const nowEpoch = this.getEpochTime(now);
 
 const filteredDevices = response.data.data.filter(device => {
 let timestamp = device.last_message_timestamp || device.last_known_timestamp;
 
 if (!timestamp) {
 return false;
 }
 
 if (timestamp > 1000000000000) {
 timestamp = Math.floor(timestamp / 1000);
 }
 
 if (timestamp < 0 || timestamp < 1000000000) {
 return false;
 }
 
 return timestamp >= fortyEightHoursAgoEpoch;
 });

 console.log(`Found ${filteredDevices.length} devices that reported in last 48 hours`);
 
 return { ...response.data, data: filteredDevices };
 } catch (error) {
 console.error(`Error fetching devices for account ${account.accountName}:`, error.message);
 return null;
 }
 }

 checkConfigDeviations(devices, accountProfile) {
 const now = new Date();
 const deviations = [];
 const allDevices = [];

 devices.forEach((device) => {
 const imei = this.cleanImei(device.imei);
 if (!imei) return;

 let lastReportTime = null;
 let hoursSinceLastReport = null;
 
 let timestamp = device.last_message_timestamp || device.last_known_timestamp;
 
 if (timestamp > 1000000000000) {
 timestamp = Math.floor(timestamp / 1000);
 }
 
 if (timestamp && !isNaN(timestamp) && timestamp > 0) {
 try {
 lastReportTime = new Date(timestamp * 1000);
 hoursSinceLastReport = (now - lastReportTime) / (1000 * 60 * 60);
 } catch (error) {
 lastReportTime = null;
 }
 }

 const currentPingFrequency = device.ping_frequency;
 const expectedPingFrequency = accountProfile.ping_frequency;
 
 const hasWrongConfig = currentPingFrequency !== expectedPingFrequency;

 allDevices.push({
 imei: imei,
 deviceType: device.device_type,
 lastReported: lastReportTime ? this.formatDate(lastReportTime) : 'Never',
 hoursSinceLastReport: hoursSinceLastReport ? hoursSinceLastReport.toFixed(2) : 'N/A',
 currentPingFrequency: currentPingFrequency || 'N/A',
 expectedFrequency: expectedPingFrequency,
 account: accountProfile.accountName,
 status: hasWrongConfig ? 'Wrong Config' : 'Normal'
 });
 
 if (hasWrongConfig) {
 deviations.push({
 imei: imei,
 deviceType: device.device_type,
 lastReported: lastReportTime ? this.formatDate(lastReportTime) : 'Never',
 hoursSinceLastReport: hoursSinceLastReport ? hoursSinceLastReport.toFixed(2) : 'N/A',
 currentPingFrequency: currentPingFrequency || 'N/A',
 expectedFrequency: expectedPingFrequency,
 account: accountProfile.accountName,
 status: 'Wrong Config',
 deviationType: 'wrong_config'
 });
 }
 });

 return {deviations, allDevices};
 }

 // FIXED: Enhanced hex command extraction for all command types
 extractCommandFromFrame(protocolFrame) {
 if (!protocolFrame || typeof protocolFrame !== 'string') {
 return null;
 }
 
 // Check if it's a hex-encoded protocol frame
 if (protocolFrame.startsWith('7E') && protocolFrame.endsWith('7E')) {
 try {
 console.log(`DEBUG: Processing protocol frame: ${protocolFrame}`);
 
 // Remove first 38 characters and last 4 characters
 if (protocolFrame.length > 42) {
 const hexPayload = protocolFrame.substring(38, protocolFrame.length - 4);
 console.log(`DEBUG: Extracted hex payload: ${hexPayload}`);
 
 // Convert hex to ASCII
 let asciiCommand = '';
 for (let i = 0; i < hexPayload.length; i += 2) {
 const hexByte = hexPayload.substring(i, i + 2);
 const charCode = parseInt(hexByte, 16);
 if (!isNaN(charCode) && charCode >= 32 && charCode <= 126) {
 asciiCommand += String.fromCharCode(charCode);
 } else if (charCode === 0) {
 // Handle null bytes
 asciiCommand += ' ';
 }
 }
 
 // Clean up the command
 asciiCommand = asciiCommand.trim();
 
 console.log(`DEBUG: Converted to ASCII: ${asciiCommand}`);
 
 if (asciiCommand && asciiCommand.length > 0) {
 return asciiCommand;
 }
 }
 
 // Fallback: Try to find F0302 marker for BSFlex specific commands
 const f0302Index = protocolFrame.indexOf('F0302');
 if (f0302Index !== -1) {
 const commandStartIndex = f0302Index + 6; // Skip "F0302a" or "F0302b"
 const commandEndIndex = protocolFrame.length - 4; // Remove checksum + 7E
 
 if (commandEndIndex > commandStartIndex) {
 const commandHex = protocolFrame.substring(commandStartIndex, commandEndIndex);
 console.log(`DEBUG: Fallback extracted hex: ${commandHex}`);
 
 let asciiCommand = '';
 for (let i = 0; i < commandHex.length; i += 2) {
 const hexByte = commandHex.substring(i, i + 2);
 const charCode = parseInt(hexByte, 16);
 if (!isNaN(charCode) && charCode >= 32 && charCode <= 126) {
 asciiCommand += String.fromCharCode(charCode);
 }
 }
 
 asciiCommand = asciiCommand.trim();
 console.log(`DEBUG: Fallback converted to ASCII: ${asciiCommand}`);
 
 if (asciiCommand && asciiCommand.length > 0) {
 return asciiCommand;
 }
 }
 }
 
 } catch (e) {
 console.log(`DEBUG: Failed to extract command from hex: ${e.message}`);
 console.log(`DEBUG: Raw protocol frame: ${protocolFrame}`);
 }
 }
 
 // If not a hex frame or extraction failed, return original
 console.log(`DEBUG: Returning original frame: ${protocolFrame}`);
 return protocolFrame;
 }

 isTimeGapCommand(command) {
 if (!command || typeof command !== 'string') return false;
 return command.trim().toUpperCase().includes('AT+TIMEGAP');
 }

 areTimeGapCommandsEquivalent(cmd1, cmd2) {
 if (!this.isTimeGapCommand(cmd1) || !this.isTimeGapCommand(cmd2)) {
 return false;
 }

 const extractTimeGapParams = (command) => {
 const match = command.match(/AT\+TIMEGAP=([^&]+)/i);
 if (match && match[1]) {
 return match[1].split(',').map(param => param.trim());
 }
 return null;
 };

 const params1 = extractTimeGapParams(cmd1);
 const params2 = extractTimeGapParams(cmd2);

 if (!params1 || !params2 || params1.length !== params2.length) {
 return false;
 }

 for (let i = 0; i < params1.length; i++) {
 if (params1[i] !== params2[i]) {
 return false;
 }
 }

 return true;
 }

 compareCommands(existingCommand, newCommand) {
 if (existingCommand === newCommand) {
 return 'exact_match';
 }

 if (this.isTimeGapCommand(existingCommand) && this.isTimeGapCommand(newCommand)) {
 if (this.areTimeGapCommandsEquivalent(existingCommand, newCommand)) {
 return 'equivalent_timegap';
 }
 return 'different_timegap';
 }

 return 'different_command';
 }

 async checkPendingCommands(imeis, accountProfile, commandToSend = null) {
 const now = new Date();
 const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
 
 const startEpoch = this.getEpochTime(twentyFourHoursAgo);
 const endEpoch = this.getEpochTime(now);

 const rbql = {
 pagination: {page_size: 100, page_num: 1},
 filters: [
 {name: "state", values: [0, 1], op: "in"},
 {name: "imei", values: imeis, op: "in"},
 {name: "created_date", op: "gte", value: startEpoch},
 {name: "created_date", op: "lte", value: endEpoch},
 {name: "imei", isNull: false},
 {name: "imei", value: " ", op: "ne"},
 {name: "state", values: [5], op: "ne"}
 ],
 sort: [{name: "updated_date", order: "desc"}],
 joins: [
 {
 join_type: "left_join",
 table_name: "bees",
 left_table_attribute: "imei",
 right_table_attribute: "imei",
 fields: [
 {name: "bee_number", readable_key: "Bee Number"},
 {name: "device_type", readable_key: 'Device Type'},
 {name: "uuid", readable_key: 'Bee UUID'}
 ],
 filters: [
 {value: 1, name: "active", table_name: "bees"}
 ]
 }
 ]
 };

 const rbqlEncoded = encodeURIComponent(JSON.stringify(rbql));
 const url = `${STATUS_BASE_URL}?rbql=${rbqlEncoded}&isResellerAdmin=true`;

 try {
 const response = await this.makeRequest({
 method: 'GET',
 url: url,
 headers: {
 'Content-Type': 'application/json',
 'apikey': API_KEY
 },
 timeout: 30000
 });

 const duplicateCommands = new Set();
 const equivalentTimeGapCommands = new Set();
 const timeGapCommands = new Set();
 const pendingCommandCounts = {};
 const pendingCommandsInfo = {};
 
 imeis.forEach(imei => {
 this.commandAnalysis[imei] = {
 hasPendingCommands: false,
 commandCount: 0,
 commands: [],
 decision: 'Send Command',
 reason: 'No pending commands found',
 existingCommandsFormatted: 'None'
 };
 });
 
 if (response.data && response.data.data) {
 response.data.data.forEach(command => {
 if (command.imei && [0, 1].includes(command.state)) {
 if (!pendingCommandCounts[command.imei]) {
 pendingCommandCounts[command.imei] = 0;
 pendingCommandsInfo[command.imei] = [];
 }
 pendingCommandCounts[command.imei]++;
 
 let actualCommand = this.extractCommandFromFrame(command.msg);
 if (!actualCommand) {
 actualCommand = command.msg;
 }
 
 const commandEntry = {
 original: command.msg,
 extracted: actualCommand,
 state: command.state,
 created_date: command.created_date,
 state_description: command.state === 0 ? 'Pending' : 'Sent'
 };
 
 pendingCommandsInfo[command.imei].push(commandEntry);
 
 if (this.commandAnalysis[command.imei]) {
 this.commandAnalysis[command.imei].hasPendingCommands = true;
 this.commandAnalysis[command.imei].commandCount++;
 this.commandAnalysis[command.imei].commands.push({
 command: actualCommand,
 state: command.state === 0 ? 'Pending' : 'Sent',
 created_date: new Date(command.created_date * 1000).toISOString()
 });
 
 // Build formatted string for existing commands
 const stateEmoji = command.state === 0 ? '⏳' : '✅';
 const commandText = `${stateEmoji} ${actualCommand}`;
 
 if (this.commandAnalysis[command.imei].existingCommandsFormatted === 'None') {
 this.commandAnalysis[command.imei].existingCommandsFormatted = commandText;
 } else {
 this.commandAnalysis[command.imei].existingCommandsFormatted += `\n${commandText}`;
 }
 }
 
 if (this.isTimeGapCommand(actualCommand)) {
 timeGapCommands.add(command.imei);
 }
 
 if (commandToSend && actualCommand) {
 const comparisonResult = this.compareCommands(actualCommand, commandToSend);
 
 if (comparisonResult === 'exact_match') {
 duplicateCommands.add(command.imei);
 if (this.commandAnalysis[command.imei]) {
 this.commandAnalysis[command.imei].decision = 'Do Not Send';
 this.commandAnalysis[command.imei].reason = 'Exact duplicate command found';
 }
 } else if (comparisonResult === 'equivalent_timegap') {
 equivalentTimeGapCommands.add(command.imei);
 if (this.commandAnalysis[command.imei]) {
 this.commandAnalysis[command.imei].decision = 'Do Not Send';
 this.commandAnalysis[command.imei].reason = 'Equivalent AT+TIMEGAP command found';
 }
 }
 }
 }
 });
 }

 timeGapCommands.forEach(imei => {
 if (this.commandAnalysis[imei] && this.commandAnalysis[imei].decision === 'Send Command') {
 this.commandAnalysis[imei].decision = 'Do Not Send';
 this.commandAnalysis[imei].reason = 'AT+TIMEGAP command found in system';
 }
 });

 Object.keys(pendingCommandCounts).forEach(imei => {
 if (pendingCommandCounts[imei] >= 4 && this.commandAnalysis[imei]) {
 this.commandAnalysis[imei].decision = 'Do Not Send';
 this.commandAnalysis[imei].reason = `Too many pending commands (${pendingCommandCounts[imei]})`;
 }
 });

 return {
 duplicateCommands,
 equivalentTimeGapCommands,
 timeGapCommands,
 pendingCommandCounts,
 pendingCommandsInfo
 };
 } catch (error) {
 console.error('Error checking pending commands:', error.message);
 return {
 duplicateCommands: new Set(),
 equivalentTimeGapCommands: new Set(),
 timeGapCommands: new Set(),
 pendingCommandCounts: {},
 pendingCommandsInfo: {}
 };
 }
 }

 async sendConfigurationCommands(imeis, accountProfile) {
 const results = [];
 const totalBatches = Math.ceil(imeis.length / BATCH_SIZE);

 for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
 const startIdx = batchNum * BATCH_SIZE;
 const endIdx = Math.min((batchNum + 1) * BATCH_SIZE, imeis.length);
 const batchImeis = imeis.slice(startIdx, endIdx);

 try {
 const command = accountProfile.profileCommand;

 const commandData = {
 protocol: "WIRE",
 imeis: batchImeis,
 commands: [command],
 password: null
 };

 const payload = {
 data: JSON.stringify(commandData)
 };

 const response = await this.makeRequest({
 method: 'POST',
 url: SEND_URL,
 headers: {
 'Content-Type': 'application/json',
 'apikey': API_KEY
 },
 data: payload,
 timeout: 30000
 });

 let status = "Failed";
 let detailedResponse = "No valid response from API";

 if (response.status === 200) {
 status = "Success";
 detailedResponse = "Command queued successfully";
 } else {
 detailedResponse = `API Error ${response.status}: ${JSON.stringify(response.data)}`;
 }

 batchImeis.forEach(imei => {
 results.push({
 imei: imei,
 command: command,
 status: status,
 response: detailedResponse,
 timestamp: this.formatDate(new Date()),
 account: accountProfile.accountName
 });
 });

 await this.delay(DELAY_BETWEEN_BATCHES);
 } catch (error) {
 const errorMsg = `Request failed: ${error.message}`;
 console.error(errorMsg);

 batchImeis.forEach(imei => {
 results.push({
 imei: imei,
 command: "N/A",
 status: "Error",
 response: errorMsg,
 timestamp: this.formatDate(new Date()),
 account: accountProfile.accountName
 });
 });
 }
 }

 return results;
 }

 async generateReport(accountName, allDevices, deviations, commandResults = [], pendingCommandsInfo = {}) {
 const workbook = new Excel.Workbook();
 
 // Main Device Status Report
 const statusWorksheet = workbook.addWorksheet('Device Status Report');
 
 statusWorksheet.columns = [
 { header: 'IMEI', key: 'imei', width: 20 },
 { header: 'Device Type', key: 'deviceType', width: 15 },
 { header: 'Last Reported', key: 'lastReported', width: 20 },
 { header: 'Hours Since Last Report', key: 'hoursSinceLastReport', width: 20 },
 { header: 'Current Ping Frequency', key: 'currentPingFrequency', width: 20 },
 { header: 'Expected Frequency', key: 'expectedFrequency', width: 20 },
 { header: 'Status', key: 'status', width: 15 },
 { header: 'Command Decision', key: 'commandDecision', width: 20 },
 { header: 'Decision Reason', key: 'decisionReason', width: 30 },
 { header: 'Pending Command Count', key: 'pendingCommandCount', width: 20 },
 { header: 'Existing Commands', key: 'existingCommands', width: 50 },
 { header: 'Command Sent', key: 'command', width: 25 },
 { header: 'Command Status', key: 'commandStatus', width: 15 }
 ];

 allDevices.forEach(device => {
 const result = commandResults.find(r => r.imei === device.imei) || {};
 const commandAnalysis = this.commandAnalysis[device.imei] || {
 decision: 'N/A',
 reason: 'Not analyzed',
 commandCount: 0,
 existingCommandsFormatted: 'None'
 };
 
 statusWorksheet.addRow({
 imei: device.imei,
 deviceType: device.deviceType,
 lastReported: device.lastReported,
 hoursSinceLastReport: device.hoursSinceLastReport,
 currentPingFrequency: device.currentPingFrequency,
 expectedFrequency: device.expectedFrequency,
 status: device.status,
 commandDecision: commandAnalysis.decision,
 decisionReason: commandAnalysis.reason,
 pendingCommandCount: commandAnalysis.commandCount,
 existingCommands: commandAnalysis.existingCommandsFormatted,
 command: result.command || 'N/A',
 commandStatus: result.status || 'N/A'
 });
 });

 // Detailed Command Analysis Sheet
 const commandWorksheet = workbook.addWorksheet('Command Analysis Details');
 
 commandWorksheet.columns = [
 { header: 'IMEI', key: 'imei', width: 20 },
 { header: 'Command Decision', key: 'decision', width: 20 },
 { header: 'Decision Reason', key: 'reason', width: 30 },
 { header: 'Total Pending Commands', key: 'totalCommands', width: 20 },
 { header: 'Existing Commands', key: 'existingCommands', width: 50 },
 { header: 'Command States', key: 'commandStates', width: 30 },
 { header: 'Command Dates', key: 'commandDates', width: 30 }
 ];

 Object.keys(this.commandAnalysis).forEach(imei => {
 const analysis = this.commandAnalysis[imei];
 const existingCommands = analysis.commands.map(c => c.command).join('; ');
 const commandStates = analysis.commands.map(c => c.state).join('; ');
 const commandDates = analysis.commands.map(c => c.created_date).join('; ');
 
 commandWorksheet.addRow({
 imei: imei,
 decision: analysis.decision,
 reason: analysis.reason,
 totalCommands: analysis.commandCount,
 existingCommands: existingCommands || 'None',
 commandStates: commandStates || 'None',
 commandDates: commandDates || 'None'
 });
 });

 // Pending Commands Detailed Sheet
 const pendingWorksheet = workbook.addWorksheet('Pending Commands Details');
 
 pendingWorksheet.columns = [
 { header: 'IMEI', key: 'imei', width: 20 },
 { header: 'Command Index', key: 'index', width: 15 },
 { header: 'Command State', key: 'state', width: 15 },
 { header: 'Command Content', key: 'command', width: 50 },
 { header: 'Created Date', key: 'createdDate', width: 25 },
 { header: 'Raw Protocol Frame', key: 'rawCommand', width: 50 }
 ];

 Object.keys(pendingCommandsInfo).forEach(imei => {
 pendingCommandsInfo[imei].forEach((cmd, index) => {
 pendingWorksheet.addRow({
 imei: imei,
 index: index + 1,
 state: cmd.state_description,
 command: cmd.extracted || 'Cannot extract',
 createdDate: new Date(cmd.created_date * 1000).toISOString(),
 rawCommand: cmd.original
 });
 });
 });

 // Style the header rows
 [statusWorksheet, commandWorksheet, pendingWorksheet].forEach(worksheet => {
 worksheet.getRow(1).eachCell(cell => {
 cell.font = { bold: true };
 cell.fill = {
 type: 'pattern',
 pattern: 'solid',
 fgColor: { argb: 'FFE0E0E0' }
 };
 });
 
 if (worksheet === statusWorksheet) {
 worksheet.getColumn('existingCommands').width = 50;
 worksheet.getColumn('existingCommands').alignment = { wrapText: true };
 }
 });

 const reportsDir = path.join(__dirname, 'reports');
 if (!fs.existsSync(reportsDir)) {
 fs.mkdirSync(reportsDir, { recursive: true });
 }

 const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
 const filename = `device_report_${accountName}_${timestamp}.xlsx`;
 const filepath = path.join(reportsDir, filename);
 
 await workbook.xlsx.writeFile(filepath);
 console.log(`Report generated: ${filepath}`);
 return filepath;
 }

 async processAccount(accountName) {
 console.log(`Processing account: ${accountName}`);
 const accountProfile = ACCOUNT_PROFILES[accountName];
 
 if (!accountProfile) {
 console.error(`No profile found for account: ${accountName}`);
 return;
 }

 try {
 this.commandAnalysis = {};

 console.log('Fetching devices...');
 const devicesData = await this.getDevicesForAccount(accountProfile);
 if (!devicesData || !devicesData.data) {
 console.log('No devices found or error fetching devices');
 await this.generateReport(accountName, [], []);
 return;
 }

 console.log(`Found ${devicesData.data.length} devices for account ${accountName}`);

 console.log('Checking for configuration deviations...');
 const {deviations, allDevices} = this.checkConfigDeviations(devicesData.data, accountProfile);
 console.log(`Found ${deviations.length} devices with configuration deviations`);

 console.log('Generating comprehensive report...');
 
 let commandResults = [];
 let pendingCommandsInfo = {};
 
 if (deviations.length > 0) {
 const commandToSend = accountProfile.profileCommand;

 console.log('Checking for pending commands...');
 const imeis = deviations.map(d => d.imei);
 const {
 duplicateCommands, 
 equivalentTimeGapCommands,
 timeGapCommands,
 pendingCommandCounts, 
 pendingCommandsInfo: pendingInfo
 } = await this.checkPendingCommands(imeis, accountProfile, commandToSend);
 
 pendingCommandsInfo = pendingInfo;
 
 Object.keys(pendingCommandsInfo).forEach(imei => {
 console.log(`DEBUG: IMEI ${imei} has ${pendingCommandsInfo[imei].length} pending commands:`);
 pendingCommandsInfo[imei].forEach((cmd, idx) => {
 console.log(` ${idx + 1}. State: ${cmd.state}, Command: ${cmd.extracted || cmd.original}`);
 });
 });

 const imeisToProcess = imeis.filter(imei => 
 !duplicateCommands.has(imei) &&
 !equivalentTimeGapCommands.has(imei) &&
 !timeGapCommands.has(imei) &&
 (!pendingCommandCounts[imei] || pendingCommandCounts[imei] < 4)
 );
 
 const imeisWithTimeGap = imeis.filter(imei => 
 timeGapCommands.has(imei)
 );
 
 if (imeisWithTimeGap.length > 0) {
 console.log(`${imeisWithTimeGap.length} devices have AT+TIMEGAP commands - NOT sending new commands`);
 }
 
 console.log(`Sending commands to ${imeisToProcess.length} devices`);

 if (imeisToProcess.length > 0) {
 console.log('Sending configuration commands...');
 commandResults = await this.sendConfigurationCommands(imeisToProcess, accountProfile);
 } else {
 console.log('No commands to send - devices have AT+TIMEGAP commands or other issues');
 }
 }

 const reportPath = await this.generateReport(accountName, allDevices, deviations, commandResults, pendingCommandsInfo);

 return {
 account: accountName,
 totalDevices: devicesData.data.length,
 deviations: deviations.length,
 commandsSent: commandResults.length,
 reportPath: reportPath
 };

 } catch (error) {
 console.error(`Error processing account ${accountName}:`, error.message);
 await this.generateReport(accountName, [], []);
 return {
 account: accountName,
 error: error.message
 };
 }
 }

 async runAutomation() {
 console.log('Starting device configuration automation...');
 const results = [];
 
 for (const accountName of Object.keys(ACCOUNT_PROFILES)) {
 const result = await this.processAccount(accountName);
 results.push(result);
 await this.delay(5000);
 }
 
 console.log('Automation completed');
 return results;
 }
}

// Initialize and run
const automation = new DeviceConfigAutomation();
automation.runAutomation().then(results => {
 console.log('Automation results:', JSON.stringify(results, null, 2));
}).catch(error => {
 console.error('Automation failed:', error);
});
