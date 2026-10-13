const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authenticateToken = require('../middleware/auth'); // Ensure this is correct in your folder structure

// HELPER FUNCTION: Safely ensure tables exist to prevent 500 crashes on fresh deployments
const ensureTablesExist = async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS wallet_transactions (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255),
                amount NUMERIC(10,2),
                transaction_type VARCHAR(50),
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                setting_key VARCHAR(255) PRIMARY KEY,
                setting_value TEXT
            );
        `);
    } catch (e) {
        console.warn('Table creation check failed (non-fatal):', e.message);
    }
};

router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // Ensure tables exist so SELECT queries don't crash the server
        await ensureTablesExist();

        // Fetch User Data - using a safer fallback if trial_ends_at doesn't exist
        let userResult;
        try {
            userResult = await db.query('SELECT wallet_balance, trial_ends_at FROM users WHERE id = $1', [userId]);
        } catch (dbErr) {
            // If trial_ends_at column is missing on production, fallback to just wallet_balance
            userResult = await db.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
        }

        if (!userResult || userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Fetch Transaction History safely
        let historyResult = { rows: [] };
        try {
            historyResult = await db.query(
                'SELECT amount, transaction_type, description, created_at FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
                [String(userId)]
            );
        } catch (historyErr) {
            console.warn("Could not fetch wallet history:", historyErr.message);
        }

        // Fetch Dynamic Fee Tiers safely
        let subscriptionTiers = [
            { name: "0 - 15 Cases", monthly: 0 },
            { name: "16 - 30 Cases", monthly: 200 },
            { name: "31 - 50 Cases", monthly: 400 },
            { name: "51 - 100 Cases", monthly: 750 },
            { name: "101+ Cases", monthly: 1500 }
        ]; // Default fallback tiers so the frontend never crashes

        try {
            const tierResult = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'subscription_tiers'");
            if (tierResult.rows.length > 0 && tierResult.rows[0].setting_value) {
                subscriptionTiers = JSON.parse(tierResult.rows[0].setting_value);
            } else {
                // Insert defaults if missing
                await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('subscription_tiers', $1)", [JSON.stringify(subscriptionTiers)]);
            }
        } catch (tierErr) {
            console.warn("Could not fetch system settings:", tierErr.message);
        }

        res.json({
            success: true,
            balance: userResult.rows[0].wallet_balance || 0,
            trial_ends_at: userResult.rows[0].trial_ends_at || new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString(), // Fallback trial date
            transactions: historyResult.rows,
            subscription_tiers: subscriptionTiers
        });
    } catch (error) {
        console.error('[WALLET API] Error fetching wallet data:', error);
        res.status(500).json({ success: false, message: 'Server error fetching wallet data' });
    }
});

// GET /api/wallet/referral-stats - Fetch referral code and stats
router.get('/referral-stats', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        let referralCode = '';
        let totalReferred = 0;

        try {
            const userRes = await db.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
            if (userRes.rows.length > 0) referralCode = userRes.rows[0].referral_code;

            const countRes = await db.query('SELECT COUNT(*) as total_referred FROM users WHERE referred_by = $1', [userId]);
            totalReferred = parseInt(countRes.rows[0].total_referred || 0);
        } catch (dbErr) {
            console.warn("Referral DB Error:", dbErr.message);
        }

        res.json({
            success: true,
            referral_code: referralCode,
            total_referred: totalReferred,
            shareable_link: `https://yourlawyerdiary.com/register?ref=${referralCode}`
        });

    } catch (error) {
        console.error('[REFERRAL API] Error fetching referral stats:', error);
        res.status(500).json({ success: false, message: 'Server error fetching referral info.' });
    }
});

// POST /api/wallet/topup - Handle bKash/Nagad top-up simulation
router.post('/topup', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { amount, provider, trxId } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid top-up amount.' });
        }

        // Use safe update strategy
        let updateResult;
        try {
            const updateQuery = `
                UPDATE users 
                SET wallet_balance = COALESCE(wallet_balance, 0) + $1,
                    trial_ends_at = CASE 
                        WHEN trial_ends_at < NOW() THEN NOW() + INTERVAL '30 days'
                        ELSE trial_ends_at + INTERVAL '30 days'
                    END
                WHERE id = $2
                RETURNING wallet_balance, trial_ends_at;
            `;
            updateResult = await db.query(updateQuery, [amount, userId]);
        } catch (updateErr) {
            // Fallback if trial_ends_at column is completely missing
            const fallbackQuery = `
                UPDATE users 
                SET wallet_balance = COALESCE(wallet_balance, 0) + $1
                WHERE id = $2
                RETURNING wallet_balance;
            `;
            updateResult = await db.query(fallbackQuery, [amount, userId]);
        }

        if (!updateResult || updateResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        try {
            await ensureTablesExist();
            await db.query(
                `INSERT INTO wallet_transactions (user_id, amount, transaction_type, description) VALUES ($1, $2, $3, $4)`,
                [String(userId), amount, 'TOPUP', `Top-up via ${provider} (TrxID: ${trxId || 'SIM'})`]
            );
        } catch (logErr) {
            console.warn('[WALLET TOPUP] Could not log transaction to history table:', logErr.message);
        }

        res.json({
            success: true,
            message: `Successfully added ৳${amount} via ${provider}!`,
            newBalance: updateResult.rows[0].wallet_balance,
            trial_ends_at: updateResult.rows[0].trial_ends_at || new Date().toISOString()
        });
    } catch (error) {
        console.error('[WALLET TOPUP] Error processing top-up:', error);
        res.status(500).json({ success: false, message: 'Server error processing top-up.' });
    }
});

module.exports = router;