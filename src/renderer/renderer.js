const fields = [
  ['serial_number', 'Serial Number', true], ['serial_override', 'Serial Override'],
  ['manufacturer', 'Manufacturer'], ['model', 'Model'], ['operating_system', 'Operating System'],
  ['processor', 'Processor'], ['storage', 'Storage'], ['memory', 'Memory'], ['gpu', 'GPU'],
  ['mac_address', 'MAC Address'], ['hostname', 'Hostname'], ['machine_type', 'Machine Type', true],
  ['acquired_on', 'Acquired On'], ['office', 'Office', true], ['par_holder', 'PAR Holder'],
  ['primary_user', 'Primary User'], ['details', 'Other Details'], ['remarks', 'Remarks']
];
let current = null;
let records = [];
let lookups = { office: [], device_type: [] };
const remoteCacheKey = 'chictool.remoteCredentials';
const pageSize = 5;
const peripheralPageSize = 5;
let currentPage = 1;
let selectedComputer = null;
let peripheralFilter = 'all';
let peripheralRecords = [];
let peripheralPage = 1;
let editingPeripheralId = null;
let inventorySort = { key: 'serial_number', direction: 'asc' };
let previousRemoteMode = false;
let authState = null;

const $ = id => document.getElementById(id);
function setStatus(message, error = false) { $('status').textContent = message; $('status').className = `status ${error ? 'error' : ''}`; }
function showAuthScreen(state) {
  authState = state;
  $('authScreen').hidden = false;
  $('appShell').hidden = true;
  $('authForm').reset();
  $('authError').textContent = '';
  const firstUser = !state.hasUsers;
  $('authMessage').textContent = firstUser ? 'Create the first local user to continue.' : 'Sign in to continue.';
  $('authSubmit').textContent = firstUser ? 'Create User' : 'Sign In';
  $('authPassword').autocomplete = firstUser ? 'new-password' : 'current-password';
}
async function enterApp(user) {
  $('authScreen').hidden = true;
  $('appShell').hidden = false;
  $('currentUser').textContent = `User: ${user.username}`;
  restoreRemoteIdentity();
  updateConnectionFields();
  const appInfo = await window.pcinfo.getAppInfo();
  $('appInfo').textContent = `Data: ${appInfo.dataPath}`;
  lookups = await window.pcinfo.listLookups();
  renderForm();
  await refresh();
  await loadPeripherals(null);
}
function renderForm(data = {}) {
  $('form').innerHTML = fields.map(([key, label, required]) => {
    const source = key === 'office' ? 'office' : key === 'machine_type' ? 'device_type' : null;
    if (!source) {
      const locked = key === 'serial_number' ? 'readonly title="Collected serial numbers cannot be edited"' : key === 'details' ? 'readonly title="Collected hardware details cannot be edited"' : '';
      const placeholder = key === 'acquired_on' ? 'placeholder="YYYY-MM-DD / YYYY"' : '';
      if (key === 'model') {
        return `<label>${label}<div class="field-with-action"><input data-field="${key}" value="${escapeHtml(data[key] || '')}" ${locked}><button type="button" class="model-cleaner" title="Remove non-alphanumeric characters from the start and end" aria-label="Clean Model">✦</button></div></label>`;
      }
      return `<label>${label}${required ? ' *' : ''}<input data-field="${key}" value="${escapeHtml(data[key] || '')}" ${required ? 'required' : ''} ${placeholder} ${locked}></label>`;
    }
    const options = lookups[source].map(item => `<option value="${escapeHtml(item.value)}" ${item.value === data[key] ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
    const legacy = data[key] && !lookups[source].some(item => item.value === data[key]) ? `<option value="${escapeHtml(data[key])}" selected>${escapeHtml(data[key])} (existing)</option>` : '';
    return `<label>${label}${required ? ' *' : ''}<select data-field="${key}" ${required ? 'required' : ''}><option value="">Select ${label.toLowerCase()}</option>${legacy}${options}</select></label>`;
  }).join('');
  $('save').disabled = !data.serial_number;
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function cleanModel(value) { return String(value || '').replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ''); }
function readForm() { return Object.fromEntries([...document.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.value.trim()])); }
function cacheRemoteIdentity() {
  localStorage.setItem(remoteCacheKey, JSON.stringify({
    hostname: $('hostname').value.trim(),
    username: $('username').value.trim()
  }));
}
async function restoreRemoteIdentity() {
  try {
    const cached = JSON.parse(localStorage.getItem(remoteCacheKey) || '{}');
    $('hostname').value = cached.hostname || '';
    $('username').value = cached.username || '';
  } catch {
    localStorage.removeItem(remoteCacheKey);
  }
  const savedPassword = await window.pcinfo.loadSavedPassword();
  $('password').value = $('mode').value === 'remote' ? savedPassword : '';
}
function chooseRecordVersion(serial) {
  return new Promise(resolve => {
    const dialog = $('recordChoice');
    $('recordChoiceMessage').textContent = `Serial number ${serial} already exists. Choose which version to load.`;
    dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true });
    dialog.showModal();
  });
}
function showSetupInstructions(filePath) {
  $('setupInstructionsText').innerHTML = `
    <p>On the target computer:</p>
    <ol>
      <li>Copy <code>${escapeHtml(filePath)}</code> to the target computer.</li>
      <li>Open PowerShell <strong>as Administrator</strong>.</li>
      <li>Run: <code>powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\chictool-target-setup.ps1</code>.</li>
      <li>Return here and click <strong>Trust target</strong>.</li>
      <li>Click <strong>Collect</strong> to test remoting and collect details.</li>
    </ol>
    <p class="setup-note">This uses a temporary process-level bypass only; it does not change the computer’s permanent execution policy or save credentials.</p>`;
  $('setupInstructions').showModal();
}
function renderRecords() {
  const query = $('search').value.trim();
  const office = $('inventoryOfficeFilter').value;
  const deviceType = $('inventoryTypeFilter').value;
  const filtered = records.filter(record =>
    (!office || record.office === office) &&
    (!deviceType || record.machine_type === deviceType) &&
    matchesBooleanSearch(record, query)
  );
  const sorted = [...filtered].sort((left, right) => {
    const leftValue = String(inventorySort.key === 'primary_user' ? (left.primary_user || left.par_holder) : left[inventorySort.key] || '').toLowerCase();
    const rightValue = String(inventorySort.key === 'primary_user' ? (right.primary_user || right.par_holder) : right[inventorySort.key] || '').toLowerCase();
    const comparison = leftValue.localeCompare(rightValue, undefined, { numeric: true });
    return inventorySort.direction === 'asc' ? comparison : -comparison;
  });
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  currentPage = Math.min(Math.max(currentPage, 1), pageCount);
  const start = (currentPage - 1) * pageSize;
  $('records').innerHTML = sorted.slice(start, start + pageSize).map(r => `<tr><td>${escapeHtml(r.serial_number)}</td><td>${escapeHtml(`${r.manufacturer || ''} ${r.model || ''}`)}</td><td>${escapeHtml(r.primary_user || r.par_holder || '')}</td><td>${escapeHtml(r.office || '')}</td><td>${escapeHtml(r.updated_by || r.created_by || 'Legacy')}</td><td><span class="button-group action-group"><button type="button" class="edit-record" data-record-id="${r.id}">Edit</button><button type="button" class="delete-record" data-record-id="${r.id}">Delete</button></span></td></tr>`).join('');
  $('pageStatus').textContent = `Page ${currentPage} of ${pageCount}`;
  $('inventoryCount').textContent = `${filtered.length} record${filtered.length === 1 ? '' : 's'}`;
  $('previousPage').disabled = currentPage <= 1;
  $('nextPage').disabled = currentPage >= pageCount;
  $('firstPage').disabled = currentPage <= 1;
  $('lastPage').disabled = currentPage >= pageCount;
}
function matchesBooleanSearch(record, query) {
  if (!query || !/[A-Za-z]{2}/.test(query)) return true;
  const text = Object.values(record).map(value => String(value ?? '')).join(' ').toLowerCase();
  const rawTokens = [...query.matchAll(/"([^"]+)"|\(|\)|\bAND\b|\bOR\b|\bNOT\b|[^\s()]+/gi)].map(match => {
    if (match[1] !== undefined) return { type: 'term', value: match[1].toLowerCase() };
    const value = match[0];
    const upper = value.toUpperCase();
    if (['AND', 'OR', 'NOT'].includes(upper)) return { type: upper };
    if (value === '(' || value === ')') return { type: value };
    return { type: 'term', value: value.toLowerCase() };
  }).filter(token => token.type !== 'term' || /[A-Za-z]{2}/.test(token.value));
  if (!rawTokens.some(token => token.type === 'term')) return true;

  const tokens = [];
  const canEnd = token => token && (token.type === 'term' || token.type === ')');
  const canStart = token => token && (token.type === 'term' || token.type === '(' || token.type === 'NOT');
  rawTokens.forEach(token => {
    if (canEnd(tokens[tokens.length - 1]) && canStart(token)) tokens.push({ type: 'AND' });
    tokens.push(token);
  });
  let index = 0;
  const parsePrimary = () => {
    const token = tokens[index++];
    if (!token) return () => false;
    if (token.type === '(') {
      const expression = parseOr();
      if (tokens[index]?.type === ')') index += 1;
      return expression;
    }
    if (token.type === 'term') return () => text.includes(token.value);
    return () => false;
  };
  const parseUnary = () => {
    if (tokens[index]?.type === 'NOT') {
      index += 1;
      const expression = parseUnary();
      return () => !expression();
    }
    return parsePrimary();
  };
  const parseAnd = () => {
    let expression = parseUnary();
    while (tokens[index]?.type === 'AND') {
      index += 1;
      const right = parseUnary();
      const left = expression;
      expression = () => left() && right();
    }
    return expression;
  };
  function parseOr() {
    let expression = parseAnd();
    while (tokens[index]?.type === 'OR') {
      index += 1;
      const right = parseAnd();
      const left = expression;
      expression = () => left() || right();
    }
    return expression;
  }
  return parseOr()();
}
async function refresh() {
  lookups = await window.pcinfo.listLookups();
  renderPeripheralTypeOptions();
  records = await window.pcinfo.listInventory();
  renderInventoryFilters();
  renderPeripheralComputerOptions();
  currentPage = 1;
  renderRecords();
}
function renderPeripheralTypeOptions() {
  const selected = $('peripheralType').value;
  $('peripheralType').innerHTML = `<option value="">Select type</option>${(lookups.peripheral_type || []).map(item => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join('')}`;
  $('peripheralType').value = selected;
}
function renderInventoryFilters() {
  const office = $('inventoryOfficeFilter').value;
  const deviceType = $('inventoryTypeFilter').value;
  $('inventoryOfficeFilter').innerHTML = `<option value="">All Offices</option>${(lookups.office || []).map(item => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join('')}`;
  $('inventoryTypeFilter').innerHTML = `<option value="">All Device Types</option>${(lookups.device_type || []).map(item => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join('')}`;
  $('inventoryOfficeFilter').value = office;
  $('inventoryTypeFilter').value = deviceType;
}
function clearPeripheralForm() {
  editingPeripheralId = null;
  ['peripheralType', 'peripheralManufacturer', 'peripheralModel', 'peripheralSerial', 'peripheralAssetTag', 'peripheralUser', 'peripheralRemarks'].forEach(id => { $(id).value = ''; });
  $('peripheralComputerSelect').value = selectedComputer ? String(selectedComputer.id) : '';
  $('addPeripheral').textContent = 'Add';
  $('cancelPeripheralEdit').hidden = true;
}
function editPeripheral(record) {
  editingPeripheralId = record.id;
  $('peripheralType').value = record.type || '';
  $('peripheralManufacturer').value = record.manufacturer || '';
  $('peripheralModel').value = record.model || '';
  $('peripheralSerial').value = record.serial_number || '';
  $('peripheralAssetTag').value = record.asset_tag || '';
  $('peripheralUser').value = record.assigned_user || '';
  $('peripheralRemarks').value = record.remarks || '';
  $('peripheralComputerSelect').value = record.computer_id ? String(record.computer_id) : '';
  $('addPeripheral').textContent = 'Save';
  $('cancelPeripheralEdit').hidden = false;
}
function renderPeripheralComputerOptions() {
  const selected = $('peripheralComputerSelect').value;
  $('peripheralComputerSelect').innerHTML = `<option value="">Unlinked</option>${records.map(record => {
    const detail = [record.primary_user, record.par_holder, record.office]
      .map(value => String(value || '').trim())
      .find(Boolean);
    return `<option value="${record.id}">${escapeHtml(record.serial_number)}${detail ? ` - ${escapeHtml(detail)}` : ''}</option>`;
  }).join('')}`;
  if (records.some(record => String(record.id) === selected)) $('peripheralComputerSelect').value = selected;
}
async function loadPeripherals(computer, filter = peripheralFilter) {
  selectedComputer = computer;
  peripheralFilter = filter;
  document.querySelectorAll('.peripheral-filters button').forEach(button => {
    const active = button.dataset.filter === filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const title = filter === 'all' ? 'All' : filter === 'unassigned' ? 'Unlinked' : computer ? `Linked to ${computer.serial_number}` : 'Linked';
  $('peripheralComputer').textContent = title;
  $('peripheralComputerSelect').value = computer ? String(computer.id) : '';
  peripheralRecords = await window.pcinfo.listPeripherals(computer ? computer.id : null, filter);
  peripheralPage = 1;
  renderPeripherals();
}
function renderPeripherals() {
  const query = $('peripheralSearch').value.trim();
  const filtered = peripheralRecords.filter(record => matchesBooleanSearch(record, query));
  const pageCount = Math.max(1, Math.ceil(filtered.length / peripheralPageSize));
  peripheralPage = Math.min(Math.max(peripheralPage, 1), pageCount);
  const start = (peripheralPage - 1) * peripheralPageSize;
  $('peripherals').innerHTML = filtered.slice(start, start + peripheralPageSize).map(item => `<tr><td>${escapeHtml(item.type)}</td><td>${escapeHtml(`${item.manufacturer || ''} ${item.model || ''}`)}</td><td>${escapeHtml(item.serial_number || '')}</td><td>${escapeHtml(item.asset_tag || '')}</td><td>${escapeHtml(item.assigned_user || '')}</td><td><span class="button-group action-group"><button type="button" class="edit-peripheral" data-peripheral-id="${item.id}">Edit</button><button type="button" class="delete-peripheral" data-peripheral-id="${item.id}">Delete</button></span></td></tr>`).join('');
  $('peripheralPageStatus').textContent = `Page ${peripheralPage} of ${pageCount}`;
  $('peripheralCount').textContent = `${filtered.length} peripheral${filtered.length === 1 ? '' : 's'}`;
  $('previousPeripheralPage').disabled = peripheralPage <= 1;
  $('nextPeripheralPage').disabled = peripheralPage >= pageCount;
  $('firstPeripheralPage').disabled = peripheralPage <= 1;
  $('lastPeripheralPage').disabled = peripheralPage >= pageCount;
}
function addEdgePaginationButtons() {
  [['firstPage', 'lastPage', 'First page', 'Last page'], ['firstPeripheralPage', 'lastPeripheralPage', 'First page', 'Last page']].forEach((ids, index) => {
    const pagination = document.querySelectorAll('.pagination')[index];
    if (!pagination) return;
    const [firstId, lastId, firstLabel, lastLabel] = ids;
    const first = document.createElement('button');
    first.id = firstId;
    first.type = 'button';
    first.textContent = '«';
    first.title = firstLabel;
    first.setAttribute('aria-label', firstLabel);
    const last = document.createElement('button');
    last.id = lastId;
    last.type = 'button';
    last.textContent = '»';
    last.title = lastLabel;
    last.setAttribute('aria-label', lastLabel);
    pagination.prepend(first);
    pagination.append(last);
  });
}

function updateConnectionFields() {
  const remote = $('mode').value === 'remote';
  if (remote && !previousRemoteMode) restoreRemoteIdentity();
  if (!remote) {
    $('hostname').value = '';
    $('username').value = '';
    $('password').value = '';
  }
  previousRemoteMode = remote;
  ['hostnameWrap', 'usernameWrap', 'passwordWrap'].forEach(id => {
    $(id).hidden = !remote;
    const input = $(id).querySelector('input');
    input.disabled = !remote;
  });
  $('trustHost').hidden = !remote;
  $('trustHost').disabled = !remote || !$('hostname').value.trim();
  $('downloadSetup').hidden = !remote;
  $('testConnection').hidden = !remote;
}
$('mode').addEventListener('change', updateConnectionFields);
$('hostname').addEventListener('input', updateConnectionFields);
$('hostname').addEventListener('input', cacheRemoteIdentity);
$('username').addEventListener('input', cacheRemoteIdentity);
['showGuide', 'showLoginGuide'].forEach(id => $(id).addEventListener('click', () => $('guideDialog').showModal()));
$('closeGuide').addEventListener('click', () => $('guideDialog').close());
$('closeGuideTop').addEventListener('click', () => $('guideDialog').close());
$('refresh').addEventListener('click', refresh);
addEdgePaginationButtons();
$('showAudit').addEventListener('click', async () => {
  try {
    const logs = await window.pcinfo.listAuditLogs();
    $('auditRecords').innerHTML = logs.map(log => `<tr><td>${escapeHtml(new Date(log.created_on).toLocaleString())}</td><td>${escapeHtml(log.actor)}</td><td>${escapeHtml(`${log.entity}${log.entity_id ? ` #${log.entity_id}` : ''}`)}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(formatAuditDetails(log.details))}</td></tr>`).join('') || '<tr><td colspan="5">No audit entries.</td></tr>';
    $('auditDialog').showModal();
  } catch (error) { setStatus(error.message, true); }
});
$('backupDatabase').addEventListener('click', async () => {
  try {
    $('backupDatabase').disabled = true;
    setStatus('Choose where to save the database backup...');
    setStatus(await window.pcinfo.backupDatabase());
  } catch (error) { setStatus(error.message, true); }
  finally { $('backupDatabase').disabled = false; }
});
$('resetDatabase').addEventListener('click', async () => {
  if (!window.confirm('Reset the inventory database? Computers, peripherals, collection logs, and audit logs will be permanently deleted. Lookup values will be retained.')) return;
  try {
    $('resetDatabase').disabled = true;
    setStatus('Resetting inventory database...');
    const counts = await window.pcinfo.resetDatabase();
    current = null;
    selectedComputer = null;
    clearPeripheralForm();
    renderForm();
    await refresh();
    await loadPeripherals(null, 'all');
    setStatus(`Inventory reset. Removed ${counts.computers} computer${counts.computers === 1 ? '' : 's'}, ${counts.peripherals} peripheral${counts.peripherals === 1 ? '' : 's'}, and related logs.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $('resetDatabase').disabled = false;
  }
});
$('exportInventory').addEventListener('click', async () => {
  try {
    $('exportInventory').disabled = true;
    setStatus('Choose where to save the inventory CSV...');
    setStatus(await window.pcinfo.exportInventoryCsv());
  } catch (error) { setStatus(error.message, true); }
  finally { $('exportInventory').disabled = false; }
});
$('zoomOut').addEventListener('click', () => window.pcinfo.zoom(-1));
$('resetZoom').addEventListener('click', () => window.pcinfo.resetZoom());
$('zoomIn').addEventListener('click', () => window.pcinfo.zoom(1));
$('search').addEventListener('input', () => { currentPage = 1; renderRecords(); });
$('inventoryOfficeFilter').addEventListener('change', () => { currentPage = 1; renderRecords(); });
$('inventoryTypeFilter').addEventListener('change', () => { currentPage = 1; renderRecords(); });
document.querySelectorAll('#inventoryTable th[data-sort]').forEach(header => header.addEventListener('click', () => {
  const key = header.dataset.sort;
  inventorySort = inventorySort.key === key
    ? { key, direction: inventorySort.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: 'asc' };
  currentPage = 1;
  renderRecords();
}));
$('previousPage').addEventListener('click', () => { currentPage -= 1; renderRecords(); });
$('nextPage').addEventListener('click', () => { currentPage += 1; renderRecords(); });
$('firstPage').addEventListener('click', () => { currentPage = 1; renderRecords(); });
$('lastPage').addEventListener('click', () => { currentPage = Number.MAX_SAFE_INTEGER; renderRecords(); });
$('records').addEventListener('click', event => {
  const button = event.target.closest('.edit-record');
  if (button) {
    const record = records.find(item => String(item.id) === button.dataset.recordId);
    if (!record) return;
    current = record;
    renderForm(record);
    loadPeripherals(record, 'assigned');
    setStatus(`Loaded ${record.serial_number} for editing. Save to apply changes.`);
    return;
  }
  const deleteButton = event.target.closest('.delete-record');
  if (!deleteButton) return;
  const record = records.find(item => String(item.id) === deleteButton.dataset.recordId);
  if (!record || !window.confirm(`Remove inventory record ${record.serial_number} from active inventory? It will be retained for audit and synchronization. Linked peripherals will become unlinked.`)) return;
  window.pcinfo.deleteInventory(record.id).then(async () => {
    if (current && String(current.id) === String(record.id)) {
      current = null;
      renderForm();
    }
    await refresh();
    await loadPeripherals(null, 'all');
    setStatus('Inventory record removed from active inventory.');
  }).catch(error => setStatus(error.message, true));
});
$('showAllPeripherals').addEventListener('click', async () => {
  await loadPeripherals(null, 'all');
  setStatus('Showing all peripherals.');
});
$('showAssignedPeripherals').addEventListener('click', async () => {
  await loadPeripherals(selectedComputer, 'assigned');
  setStatus(selectedComputer ? `Showing peripherals linked to ${selectedComputer.serial_number}.` : 'Showing all linked peripherals.');
});
$('showUnassignedPeripherals').addEventListener('click', async () => {
  await loadPeripherals(null, 'unassigned');
  setStatus('Showing unlinked peripherals.');
});
$('previousPeripheralPage').addEventListener('click', () => { peripheralPage -= 1; renderPeripherals(); });
$('nextPeripheralPage').addEventListener('click', () => { peripheralPage += 1; renderPeripherals(); });
$('firstPeripheralPage').addEventListener('click', () => { peripheralPage = 1; renderPeripherals(); });
$('lastPeripheralPage').addEventListener('click', () => { peripheralPage = Number.MAX_SAFE_INTEGER; renderPeripherals(); });
$('peripheralSearch').addEventListener('input', () => { peripheralPage = 1; renderPeripherals(); });
$('addPeripheral').addEventListener('click', async () => {
  try {
    const wasEditing = Boolean(editingPeripheralId);
    await window.pcinfo.savePeripheral({
      id: editingPeripheralId,
      computer_id: $('peripheralComputerSelect').value || null,
      type: $('peripheralType').value,
      manufacturer: $('peripheralManufacturer').value,
      model: $('peripheralModel').value,
      serial_number: $('peripheralSerial').value,
      asset_tag: $('peripheralAssetTag').value,
      assigned_user: $('peripheralUser').value,
      remarks: $('peripheralRemarks').value
    });
    await loadPeripherals(selectedComputer, peripheralFilter);
    clearPeripheralForm();
    setStatus(wasEditing ? 'Peripheral updated.' : 'Peripheral added.');
  } catch (error) { setStatus(error.message, true); }
});
$('cancelPeripheralEdit').addEventListener('click', () => {
  clearPeripheralForm();
  setStatus('Peripheral edit cancelled.');
});
$('peripherals').addEventListener('click', async event => {
  const editButton = event.target.closest('.edit-peripheral');
  if (editButton) {
    const record = peripheralRecords.find(item => String(item.id) === editButton.dataset.peripheralId);
    if (record) editPeripheral(record);
    return;
  }
  const button = event.target.closest('.delete-peripheral');
  if (!button) return;
  if (!window.confirm('Remove this peripheral from active inventory? It will be retained for audit and synchronization.')) return;
  await window.pcinfo.deletePeripheral(button.dataset.peripheralId);
  await loadPeripherals(selectedComputer, peripheralFilter);
  setStatus('Peripheral removed from active inventory.');
});
$('trustHost').addEventListener('click', async () => {
  try {
    const hostname = $('hostname').value.trim();
    $('trustHost').disabled = true;
    setStatus('Requesting administrator approval to update TrustedHosts...');
    const message = await window.pcinfo.addTrustedHost(hostname);
    setStatus(message);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    updateConnectionFields();
  }
});
$('downloadSetup').addEventListener('click', async () => {
  try {
    setStatus('Choose where to save the target setup script...');
    const message = await window.pcinfo.downloadTargetSetup();
    setStatus(message);
    if (!message.endsWith('cancelled.')) {
      showSetupInstructions(message.replace(/^Target setup script saved to /, ''));
    }
  } catch (error) {
    setStatus(error.message, true);
  }
});
$('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    $('authSubmit').disabled = true;
    $('authError').textContent = '';
    const user = authState.hasUsers
      ? await window.pcinfo.login($('authUsername').value, $('authPassword').value)
      : await window.pcinfo.registerUser($('authUsername').value, $('authPassword').value);
    await enterApp(user);
  } catch (error) {
    $('authError').textContent = error.message;
  } finally {
    $('authSubmit').disabled = false;
  }
});
$('addUser').addEventListener('click', () => {
  $('userForm').reset();
  $('userError').textContent = '';
  $('userDialog').showModal();
});
$('cancelUser').addEventListener('click', () => $('userDialog').close());
$('userForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if ($('newPassword').value !== $('confirmPassword').value) throw new Error('Passwords do not match.');
    await window.pcinfo.registerUser($('newUsername').value, $('newPassword').value);
    $('userDialog').close();
    setStatus('User registered successfully.');
  } catch (error) {
    $('userError').textContent = error.message;
  }
});
$('logout').addEventListener('click', async () => {
  await window.pcinfo.logout();
  showAuthScreen(await window.pcinfo.authState());
});
$('testConnection').addEventListener('click', async () => {
  try {
    $('testConnection').disabled = true;
    setStatus('Testing remote connection...');
    const result = await window.pcinfo.testConnection({ mode: 'remote', hostname: $('hostname').value, username: $('username').value, password: $('password').value });
    await window.pcinfo.saveRemotePassword($('password').value);
    setStatus(`Connection succeeded: ${result.hostname || 'target responded'}.`);
  } catch (error) { setStatus(error.message, true); }
  finally { $('testConnection').disabled = false; }
});
$('collect').addEventListener('click', async () => {
  try {
    setStatus('Collecting hardware information...'); $('collect').disabled = true;
    const collected = await window.pcinfo.collectInventory({ mode: $('mode').value, hostname: $('hostname').value, username: $('username').value, password: $('password').value });
    if ($('mode').value === 'remote') await window.pcinfo.saveRemotePassword($('password').value);
    const existing = records.find(record => String(record.serial_number || '').trim().toUpperCase() === String(collected.serial_number || '').trim().toUpperCase());
    if (existing) {
      const choice = await chooseRecordVersion(collected.serial_number);
      if (choice === 'cancel') {
        setStatus('Load cancelled. No values were changed.');
        return;
      }
      current = choice === 'new' ? { ...existing, ...collected, serial_number: existing.serial_number } : existing;
      renderForm({ ...current, hostname: current.hostname || $('hostname').value });
      setStatus(choice === 'new' ? 'Collected values loaded for review.' : 'Saved values loaded for review.');
      return;
    }
    current = collected;
    renderForm({ ...current, hostname: current.hostname || $('hostname').value });
    setStatus('Collection complete. Review the fields, then save.');
  } catch (error) { setStatus(error.message, true); } finally { $('collect').disabled = false; }
});
$('save').addEventListener('click', async () => {
  try { current = await window.pcinfo.saveInventory(readForm()); await refresh(); setStatus('Inventory record saved.'); }
  catch (error) { setStatus(error.message, true); }
});
$('clear').addEventListener('click', () => {
  current = null;
  renderForm();
  setStatus('Form cleared. Existing inventory records were not changed.');
});
$('form').addEventListener('click', event => {
  if (!event.target.closest('.model-cleaner')) return;
  const model = document.querySelector('[data-field="model"]');
  if (!model) return;
  model.value = cleanModel(model.value);
  setStatus('Model value cleaned.');
});
function formatAuditDetails(details) {
  if (!details || typeof details !== 'object') return '';
  return details.serial_number || details.type || details.destination || (details.count !== undefined ? `Records: ${details.count}` : '');
}
(async function start() {
  const state = await window.pcinfo.authState();
  if (state.currentUser) await enterApp(state.currentUser);
  else showAuthScreen(state);
})();
