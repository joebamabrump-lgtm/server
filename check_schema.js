const { pool } = require('./db');

async function checkSchema() {
    try {
        console.log('🔍 Checking schema for table "keys"...');
        const { rows } = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'keys'
        `);
        console.log('Columns in "keys":', rows.map(r => r.column_name).join(', '));

        console.log('\n🔍 Checking schema for table "logged_data"...');
        const { rows: rows2 } = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'logged_data'
        `);
        console.log('Columns in "logged_data":', rows2.map(r => r.column_name).join(', '));

        process.exit(0);
    } catch (err) {
        console.error('❌ Error checking schema:', err);
        process.exit(1);
    }
}

checkSchema();
