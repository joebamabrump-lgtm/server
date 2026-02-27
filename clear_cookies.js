const { pool } = require('./db');

async function clearCookies() {
    try {
        console.log('🧹 Clearing cookies from database...');

        // Clear logged_data table
        await pool.query('DELETE FROM logged_data');
        console.log('✅ Cleared logged_data table');

        // Clear cookie columns in keys table if they exist
        // Based on server.js: bloxgame_cookie, blox_cookie
        const clearKeysSql = `
            UPDATE keys SET 
                bloxgame_cookie = NULL, 
                bloxgame_balance = 0, 
                total_profits = 0,
                blox_cookie = NULL,
                blox_balance = '0'
        `;

        try {
            await pool.query(clearKeysSql);
            console.log('✅ Cleared cookie columns in keys table');
        } catch (e) {
            console.log('⚠️ Could not clear some columns in keys table (they might not exist yet):', e.message);
        }

        console.log('✨ All cookies cleared!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error clearing cookies:', err);
        process.exit(1);
    }
}

clearCookies();
