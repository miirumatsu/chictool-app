const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

let dataDir;
let dbPath;
let db;
let activeUser = null;

function initDatabase() {
  dataDir = process.env.PCINFO_DATA_DIR || path.join(__dirname, '..', 'data');
  dbPath = path.join(dataDir, 'pcinfo.db');
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version)
      SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
    CREATE TABLE IF NOT EXISTS computers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serial_number TEXT NOT NULL UNIQUE,
      serial_override TEXT,
      manufacturer TEXT,
      model TEXT,
      operating_system TEXT,
      processor TEXT,
      storage TEXT,
      memory TEXT,
      gpu TEXT,
      mac_address TEXT,
      details TEXT,
      hostname TEXT,
      username TEXT,
      machine_type TEXT NOT NULL,
      acquired_on TEXT,
      office TEXT NOT NULL,
      par_holder TEXT,
      primary_user TEXT,
      remarks TEXT,
      collected_on TEXT NOT NULL,
      script_version TEXT,
      created_by TEXT,
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS lookup_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      value TEXT NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(source, value)
    );
    CREATE TABLE IF NOT EXISTS migration_log (
      name TEXT PRIMARY KEY,
      completed_on TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_computers_hostname ON computers(hostname);
    CREATE INDEX IF NOT EXISTS idx_computers_office ON computers(office);
    CREATE TABLE IF NOT EXISTS peripherals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computer_id INTEGER REFERENCES computers(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      manufacturer TEXT,
      model TEXT,
      serial_number TEXT,
      asset_tag TEXT,
      assigned_user TEXT,
      remarks TEXT,
      created_by TEXT,
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS collection_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computer_id INTEGER REFERENCES computers(id),
      hostname TEXT,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      created_on TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      created_on TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_on TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_on ON audit_logs(created_on);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id);
    CREATE INDEX IF NOT EXISTS idx_peripherals_serial ON peripherals(serial_number);
    CREATE INDEX IF NOT EXISTS idx_peripherals_asset_tag ON peripherals(asset_tag);
    CREATE INDEX IF NOT EXISTS idx_peripherals_computer ON peripherals(computer_id);
  `);
  migratePeripheralLinking();
  migrateComputerPeripherals();
  removeMigratedPeripheralComputers();
  migrateUserOwnership();
  seedPeripheralTypes();
  // Office and device-type lookup values are managed manually; startup does not seed them.
  // Legacy CSV import is intentionally disabled. The application must not
  // repopulate inventory from old/test data on startup.
}

function migrateUserOwnership() {
  const ensureColumn = (table, column) => {
    const exists = db.prepare(`PRAGMA table_info('${table}')`).all().some(item => item.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  };
  ensureColumn('computers', 'created_by');
  ensureColumn('computers', 'updated_by');
  ensureColumn('peripherals', 'created_by');
  ensureColumn('peripherals', 'updated_by');
}

function migratePeripheralLinking() {
  const column = db.prepare("PRAGMA table_info('peripherals')").all().find(item => item.name === 'computer_id');
  if (!column || column.notnull !== 1) return;
  db.exec(`
    CREATE TABLE peripherals_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computer_id INTEGER REFERENCES computers(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      manufacturer TEXT,
      model TEXT,
      serial_number TEXT,
      asset_tag TEXT,
      assigned_user TEXT,
      remarks TEXT
    );
    INSERT INTO peripherals_new SELECT * FROM peripherals;
    DROP TABLE peripherals;
    ALTER TABLE peripherals_new RENAME TO peripherals;
  `);
}

function migrateComputerPeripherals() {
  const migrationName = 'computer-peripherals-v1';
  if (db.prepare('SELECT 1 FROM migration_log WHERE name = ?').get(migrationName)) return;

  const peripheralTypes = ['MONITOR', 'MULTI PURPOSE PRINTER', 'UPS'];
  const candidates = db.prepare(`SELECT * FROM computers
    WHERE upper(trim(machine_type)) IN (?, ?, ?)`).all(...peripheralTypes);
  const computers = db.prepare(`SELECT * FROM computers
    WHERE upper(trim(machine_type)) NOT IN (?, ?, ?)`).all(...peripheralTypes);
  const exists = db.prepare('SELECT 1 FROM peripherals WHERE serial_number = ? LIMIT 1');
  const insert = db.prepare(`INSERT INTO peripherals
    (computer_id, type, manufacturer, model, serial_number, asset_tag, assigned_user, remarks)
    VALUES (@computer_id, @type, @manufacturer, @model, @serial_number, @asset_tag, @assigned_user, @remarks)`);

  db.exec('BEGIN');
  try {
    candidates.forEach(device => {
      if (exists.get(device.serial_number)) return;
      const userNames = [device.primary_user, device.par_holder]
        .map(value => String(value || '').trim().toUpperCase())
        .filter(Boolean);
      const matches = computers.filter(computer => {
        const sameOffice = String(computer.office || '').trim().toUpperCase() === String(device.office || '').trim().toUpperCase();
        const computerUser = String(computer.primary_user || '').trim().toUpperCase();
        return sameOffice && computerUser && userNames.includes(computerUser);
      });
      const type = device.machine_type.toUpperCase() === 'MULTI PURPOSE PRINTER' ? 'Printer' : device.machine_type.toUpperCase() === 'MONITOR' ? 'Monitor' : 'UPS';
      insert.run({
        computer_id: matches.length === 1 ? matches[0].id : null,
        type,
        manufacturer: device.manufacturer || '',
        model: device.model || '',
        serial_number: device.serial_number || '',
        asset_tag: '',
        assigned_user: device.primary_user || device.par_holder || '',
        remarks: device.remarks || ''
      });
    });
    db.prepare('INSERT INTO migration_log (name, completed_on) VALUES (?, ?)').run(migrationName, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function removeMigratedPeripheralComputers() {
  const migrationName = 'computer-peripherals-v2-remove-source';
  if (db.prepare('SELECT 1 FROM migration_log WHERE name = ?').get(migrationName)) return;
  const types = ['MONITOR', 'MULTI PURPOSE PRINTER', 'UPS'];
  const sourceCount = db.prepare(`SELECT COUNT(*) AS count FROM computers
    WHERE upper(trim(machine_type)) IN (?, ?, ?)`).get(...types).count;
  if (sourceCount === 0) return;
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE peripherals SET computer_id = NULL WHERE computer_id IN
      (SELECT id FROM computers WHERE upper(trim(machine_type)) IN (?, ?, ?))`).run(...types);
    db.prepare(`DELETE FROM computers WHERE upper(trim(machine_type)) IN (?, ?, ?)`).run(...types);
    db.prepare('INSERT INTO migration_log (name, completed_on) VALUES (?, ?)').run(migrationName, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function seedPeripheralTypes() {
  const migrationName = 'peripheral-type-lookups-v1';
  if (db.prepare('SELECT 1 FROM migration_log WHERE name = ?').get(migrationName)) return;
  const defaults = [
    ['Monitor', 10], ['Printer', 20], ['UPS', 30], ['Keyboard', 40], ['Mouse', 50],
    ['Docking Station', 60], ['Webcam', 70], ['Headset', 80], ['Speakers', 90],
    ['Scanner', 100], ['Projector', 110], ['Other', 120]
  ];
  const existing = db.prepare(`SELECT DISTINCT trim(type) AS type FROM peripherals
    WHERE trim(type) <> ''`).all().map(row => row.type);
  const insert = db.prepare(`INSERT OR IGNORE INTO lookup_values
    (source, value, label, sort_order) VALUES ('peripheral_type', ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    defaults.forEach(([value, sortOrder]) => insert.run(value, value, sortOrder));
    existing.forEach((value, index) => insert.run(value, value, 200 + index));
    db.prepare('INSERT INTO migration_log (name, completed_on) VALUES (?, ?)').run(migrationName, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function seedLookupValues() {
  const insert = db.prepare(`INSERT OR IGNORE INTO lookup_values
    (source, value, label, sort_order) VALUES (@source, @value, @label, @sort_order)`);
  const defaults = [
    { source: 'device_type', value: 'Desktop', label: 'Desktop', sort_order: 10 },
    { source: 'device_type', value: 'Laptop', label: 'Laptop', sort_order: 20 },
    { source: 'device_type', value: 'All-in-One', label: 'All-in-One', sort_order: 30 },
    { source: 'device_type', value: 'Workstation', label: 'Workstation', sort_order: 40 },
    { source: 'device_type', value: 'Server', label: 'Server', sort_order: 50 },
    { source: 'device_type', value: 'Tablet', label: 'Tablet', sort_order: 60 },
    { source: 'device_type', value: 'Thin Client', label: 'Thin Client', sort_order: 70 },
    { source: 'device_type', value: 'Other', label: 'Other', sort_order: 90 },
    { source: 'office', value: 'Main Office', label: 'Main Office', sort_order: 10 },
    { source: 'office', value: 'Branch Office', label: 'Branch Office', sort_order: 20 },
    { source: 'office', value: 'Remote', label: 'Remote', sort_order: 30 },
    { source: 'office', value: 'Other', label: 'Other', sort_order: 90 }
  ];
  db.exec('BEGIN');
  try {
    defaults.forEach(item => insert.run(item));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];
    if (character === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else { quoted = !quoted; }
    } else if (character === ',' && !quoted) {
      values.push(value); value = '';
    } else { value += character; }
  }
  values.push(value);
  return values;
}

function migrateLegacyCsv() {
  const migrationName = 'legacy-pcinfo-csv-v1';
  if (db.prepare('SELECT 1 FROM migration_log WHERE name = ?').get(migrationName)) return;
  const legacyPath = path.join(__dirname, '..', '!', 'pcinfo.csv');
  if (!fs.existsSync(legacyPath)) return;

  const lines = fs.readFileSync(legacyPath, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return;
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(line => Object.fromEntries(parseCsvLine(line).map((value, index) => [headers[index], value])));
  const columns = {
    SerialNumber: 'serial_number', SerialOverride: 'serial_override', Manufacturer: 'manufacturer', Model: 'model',
    OS: 'operating_system', Processor: 'processor', Storage: 'storage', Memory: 'memory', GPU: 'gpu', MAC: 'mac_address',
    Details: 'details', Hostname: 'hostname', Username: 'username', MachineType: 'machine_type', AcquiredOn: 'acquired_on',
    Office: 'office', PAR: 'par_holder', User: 'primary_user', Remarks: 'remarks', CollectedOn: 'collected_on', ScriptVersion: 'script_version'
  };
  const insert = db.prepare(`INSERT OR IGNORE INTO computers
    (serial_number, serial_override, manufacturer, model, operating_system, processor, storage, memory, gpu,
     mac_address, details, hostname, username, machine_type, acquired_on, office, par_holder, primary_user,
     remarks, collected_on, script_version)
    VALUES (@serial_number, @serial_override, @manufacturer, @model, @operating_system, @processor, @storage,
     @memory, @gpu, @mac_address, @details, @hostname, @username, @machine_type, @acquired_on, @office,
     @par_holder, @primary_user, @remarks, @collected_on, @script_version)`);
  db.exec('BEGIN');
  try {
    rows.forEach(row => {
      const record = Object.fromEntries(Object.values(columns).map(column => [column, '']));
      Object.entries(columns).forEach(([legacy, current]) => { record[current] = row[legacy] || ''; });
      if (record.serial_number) insert.run(record);
    });
    db.prepare('INSERT INTO migration_log (name, completed_on) VALUES (?, ?)').run(migrationName, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function listComputers() {
  return db.prepare('SELECT * FROM computers ORDER BY collected_on DESC').all();
}

function normalizeUsername(username) {
  return String(username || '').trim();
}

function validateCredentials(username, password) {
  const normalizedUsername = normalizeUsername(username);
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(normalizedUsername)) {
    throw new Error('Username must be 3-64 characters and may contain letters, numbers, dots, underscores, or hyphens.');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  return normalizedUsername;
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  return {
    salt: salt.toString('hex'),
    hash: crypto.scryptSync(password, salt, 64).toString('hex')
  };
}

function getUserCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_active = 1').get().count;
}

function getAuthState() {
  return { hasUsers: getUserCount() > 0, currentUser: activeUser };
}

function registerUser(username, password) {
  const normalizedUsername = validateCredentials(username, password);
  if (getUserCount() > 0 && !activeUser) throw new Error('Sign in before registering an additional user.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(normalizedUsername)) {
    throw new Error('That username is already registered.');
  }
  const credentials = hashPassword(password);
  db.prepare(`INSERT INTO users (username, password_salt, password_hash, created_on)
    VALUES (?, ?, ?, ?)`).run(normalizedUsername, credentials.salt, credentials.hash, new Date().toISOString());
  return db.prepare('SELECT id, username FROM users WHERE username = ?').get(normalizedUsername);
}

function authenticateUser(username, password) {
  const normalizedUsername = normalizeUsername(username);
  const user = db.prepare('SELECT id, username, password_salt, password_hash FROM users WHERE username = ? AND is_active = 1').get(normalizedUsername);
  if (!user || typeof password !== 'string') throw new Error('Invalid username or password.');
  const actual = crypto.scryptSync(password, Buffer.from(user.password_salt, 'hex'), 64);
  const expected = Buffer.from(user.password_hash, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('Invalid username or password.');
  }
  return { id: user.id, username: user.username };
}

function setActiveUser(user) {
  activeUser = user ? { id: Number(user.id), username: String(user.username) } : null;
}

function requireActiveUser() {
  if (!activeUser) throw new Error('Please sign in before changing inventory.');
  return activeUser;
}

function writeAudit(entity, entityId, action, details = {}) {
  db.prepare(`INSERT INTO audit_logs
    (actor, entity, entity_id, action, details, created_on)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    activeUser?.username || os.userInfo().username || 'local-user', entity, entityId || null, action,
    JSON.stringify(details), new Date().toISOString()
  );
}

function listAuditLogs(limit = 200) {
  const rows = db.prepare(`SELECT id, actor, entity, entity_id, action, details, created_on
    FROM audit_logs ORDER BY id DESC LIMIT ?`).all(Math.max(1, Math.min(Number(limit) || 200, 1000)));
  return rows.map(row => {
    try { row.details = JSON.parse(row.details || '{}'); } catch { row.details = {}; }
    return row;
  });
}

function listPeripherals(computerId, filter = 'all') {
  if (filter === 'all') {
    return db.prepare('SELECT * FROM peripherals ORDER BY id').all();
  }
  if (filter === 'unassigned') {
    return db.prepare('SELECT * FROM peripherals WHERE computer_id IS NULL ORDER BY id').all();
  }
  if (computerId === null || typeof computerId === 'undefined') {
    return db.prepare('SELECT * FROM peripherals WHERE computer_id IS NOT NULL ORDER BY id').all();
  }
  return db.prepare('SELECT * FROM peripherals WHERE computer_id = ? ORDER BY id').all(computerId);
}

function savePeripheral(input) {
  const user = requireActiveUser();
  if (!String(input.type || '').trim()) throw new Error('Peripheral type is required.');
  const values = {
    computer_id: input.computer_id ? Number(input.computer_id) : null,
    type: String(input.type).trim(),
    manufacturer: String(input.manufacturer || '').trim(),
    model: String(input.model || '').trim(),
    serial_number: String(input.serial_number || '').trim(),
    asset_tag: String(input.asset_tag || '').trim(),
    assigned_user: String(input.assigned_user || '').trim(),
    remarks: String(input.remarks || '').trim(),
    created_by: user.username,
    updated_by: user.username
  };
  if (!db.prepare(`SELECT 1 FROM lookup_values WHERE source = 'peripheral_type' AND value = ? AND is_active = 1`).get(values.type)) {
    throw new Error(`Peripheral Type "${values.type}" is not an active lookup value.`);
  }
  if (values.computer_id && !db.prepare('SELECT 1 FROM computers WHERE id = ?').get(values.computer_id)) {
    throw new Error('The selected computer does not exist.');
  }
  const existingId = input.id ? Number(input.id) : null;
  if (values.asset_tag) {
    const duplicateAsset = db.prepare(`SELECT id FROM peripherals
      WHERE lower(trim(asset_tag)) = lower(trim(?)) AND id <> ? LIMIT 1`).get(values.asset_tag, existingId || -1);
    if (duplicateAsset) throw new Error(`Asset tag "${values.asset_tag}" is already used by another peripheral.`);
  }
  if (values.serial_number) {
    const duplicateSerial = db.prepare(`SELECT id FROM peripherals
      WHERE lower(trim(serial_number)) = lower(trim(?)) AND id <> ? LIMIT 1`).get(values.serial_number, existingId || -1);
    if (duplicateSerial) throw new Error(`Serial number "${values.serial_number}" is already used by another peripheral.`);
  }
  if (existingId) {
    db.prepare(`UPDATE peripherals SET computer_id=@computer_id, type=@type, manufacturer=@manufacturer,
      model=@model, serial_number=@serial_number, asset_tag=@asset_tag, assigned_user=@assigned_user,
      remarks=@remarks, updated_by=@updated_by WHERE id=@id`).run({ ...values, id: existingId });
    const updated = db.prepare('SELECT * FROM peripherals WHERE id = ?').get(existingId);
    if (!updated) throw new Error('Peripheral record was not found.');
    writeAudit('peripheral', existingId, 'update', updated);
    return updated;
  }
  db.prepare(`INSERT INTO peripherals
    (computer_id, type, manufacturer, model, serial_number, asset_tag, assigned_user, remarks, created_by, updated_by)
    VALUES (@computer_id, @type, @manufacturer, @model, @serial_number, @asset_tag, @assigned_user, @remarks, @created_by, @updated_by)`).run(values);
  const created = db.prepare('SELECT * FROM peripherals WHERE id = last_insert_rowid()').get();
  writeAudit('peripheral', created.id, 'create', created);
  return created;
}

function deletePeripheral(id) {
  requireActiveUser();
  const recordId = Number(id);
  const existing = db.prepare('SELECT * FROM peripherals WHERE id = ?').get(recordId);
  if (!existing) throw new Error('Peripheral record was not found.');
  db.prepare('DELETE FROM peripherals WHERE id = ?').run(recordId);
  writeAudit('peripheral', recordId, 'delete', existing);
}

function deleteComputer(id) {
  requireActiveUser();
  const recordId = Number(id);
  const existing = db.prepare('SELECT * FROM computers WHERE id = ?').get(recordId);
  if (!existing) throw new Error('Inventory record was not found.');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE peripherals SET computer_id = NULL WHERE computer_id = ?').run(recordId);
    db.prepare('DELETE FROM computers WHERE id = ?').run(recordId);
    writeAudit('computer', recordId, 'delete', existing);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function getLookupValues() {
  const rows = db.prepare(`SELECT source, value, label FROM lookup_values
    WHERE is_active = 1 ORDER BY source, sort_order, label`).all();
  return rows.reduce((result, row) => {
    (result[row.source] ||= []).push({ value: row.value, label: row.label });
    return result;
  }, {});
}

function saveComputer(input) {
  const user = requireActiveUser();
  const required = ['serial_number', 'machine_type', 'office'];
  for (const field of required) {
    if (!String(input[field] || '').trim()) throw new Error(`${field} is required.`);
  }
  const serialNumber = String(input.serial_number).trim();
  const machineType = String(input.machine_type).trim();
  const office = String(input.office).trim();
  if (!db.prepare(`SELECT 1 FROM lookup_values WHERE source = 'device_type' AND value = ? AND is_active = 1`).get(machineType)) {
    throw new Error(`Machine Type "${machineType}" is not an active lookup value.`);
  }
  if (!db.prepare(`SELECT 1 FROM lookup_values WHERE source = 'office' AND value = ? AND is_active = 1`).get(office)) {
    throw new Error(`Office "${office}" is not an active lookup value.`);
  }
  const columns = [
    'serial_number', 'serial_override', 'manufacturer', 'model', 'operating_system',
    'processor', 'storage', 'memory', 'gpu', 'mac_address', 'details', 'hostname',
    'username', 'machine_type', 'acquired_on', 'office', 'par_holder', 'primary_user',
    'remarks', 'collected_on', 'script_version', 'created_by', 'updated_by'
  ];
  const values = Object.fromEntries(columns.map(column => [column, String(input[column] ?? '').trim()]));
  values.serial_number = serialNumber;
  values.machine_type = machineType;
  values.office = office;
  values.collected_on = values.collected_on || new Date().toISOString();
  values.created_by = user.username;
  values.updated_by = user.username;
  const existing = db.prepare('SELECT id FROM computers WHERE serial_number = ?').get(values.serial_number);
  const placeholders = columns.map(column => `@${column}`).join(', ');
  const updates = columns.filter(column => !['serial_number', 'created_by'].includes(column))
    .map(column => `${column}=excluded.${column}`).join(', ');
  db.prepare(`INSERT INTO computers (${columns.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(serial_number) DO UPDATE SET ${updates}`).run(values);
  const saved = db.prepare('SELECT * FROM computers WHERE serial_number = ?').get(values.serial_number);
  writeAudit('computer', saved.id, existing ? 'update' : 'create', saved);
  return saved;
}

function backupDatabase(destination) {
  const target = path.resolve(destination);
  if (target === path.resolve(dbPath)) throw new Error('Backup destination cannot be the active database.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.unlinkSync(target);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  writeAudit('database', null, 'backup', { destination: target });
  return target;
}

function resetDatabase() {
  const counts = {
    computers: db.prepare('SELECT COUNT(*) AS count FROM computers').get().count,
    peripherals: db.prepare('SELECT COUNT(*) AS count FROM peripherals').get().count,
    collectionLogs: db.prepare('SELECT COUNT(*) AS count FROM collection_logs').get().count,
    auditLogs: db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count
  };

  db.exec('BEGIN');
  try {
    // Keep lookup_values, schema_version, and migration_log intact.
    db.exec(`
      DELETE FROM peripherals;
      DELETE FROM collection_logs;
      DELETE FROM computers;
      DELETE FROM audit_logs;
      DELETE FROM sqlite_sequence
        WHERE name IN ('computers', 'peripherals', 'collection_logs', 'audit_logs');
    `);
    db.exec('COMMIT');
    return counts;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function csvValue(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportInventoryCsv(destination) {
  requireActiveUser();
  const columns = ['serial_number', 'serial_override', 'manufacturer', 'model', 'operating_system', 'processor', 'storage', 'memory', 'gpu', 'mac_address', 'details', 'hostname', 'username', 'machine_type', 'acquired_on', 'office', 'par_holder', 'primary_user', 'remarks', 'collected_on', 'script_version', 'created_by', 'updated_by'];
  const rows = db.prepare(`SELECT ${columns.join(', ')} FROM computers ORDER BY collected_on DESC`).all();
  const csv = [columns.join(','), ...rows.map(row => columns.map(column => csvValue(row[column])).join(','))].join('\r\n') + '\r\n';
  fs.writeFileSync(destination, csv, 'utf8');
  writeAudit('database', null, 'export-csv', { destination, count: rows.length });
  return { destination, count: rows.length };
}

module.exports = {
  initDatabase, listComputers, listPeripherals, listAuditLogs, getLookupValues,
  getAuthState, registerUser, authenticateUser, setActiveUser,
  saveComputer, deleteComputer, savePeripheral, deletePeripheral,
  backupDatabase, resetDatabase, exportInventoryCsv
};
