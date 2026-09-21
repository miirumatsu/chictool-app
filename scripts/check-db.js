const { initDatabase, getLookupValues } = require('../src/database');
initDatabase();
console.log('SQLite database initialized.');
console.log(JSON.stringify(getLookupValues(), null, 2));
