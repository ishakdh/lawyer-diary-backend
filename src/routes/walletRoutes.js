const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Smart Middleware Loader to prevent path mismatch crashes
let authenticateToken;
try {
    authenticateToken = require('../middleware/authenticateToken');
} catch (e) {
    authenticateToken = require('../middleware/auth');
}

// HELPER FUNCTION: Automatically fix missing columns and tables to prevent 500 crashes
const ensureTablesExist = async () => {
    try {
        // 1. Ensure transactions table exists
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

        // 2. Ensure system_settings table exists
        await db.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                                                           setting_key VARCHAR(255) PRIMARY KEY,
                setting_value TEXT
                );
        `);

        // 3. Ensure payment_webhooks table exists for the Android SMS reader
        await db.query(`
            CREATE TABLE IF NOT EXISTS payment_webhooks (
                                                            id SERIAL PRIMARY KEY,
                                                            sender_number VARCHAR(20) NOT NULL,
                transaction_id VARCHAR(50) UNIQUE NOT NULL,
                gateway VARCHAR(20) NOT NULL,
                amount NUMERIC(10, 2) NOT NULL,
                status VARCHAR(30) DEFAULT 'WAITING FOR REQ',
                claimed_by_user_id VARCHAR(255),
                claimed_at TIMESTAMP,
                received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
        `);

        // 4. CRITICAL: Inject missing columns into users table if they don't exist
        await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(10,2) DEFAULT 0.00;`);
        await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);
        await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50);`);
        await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by VARCHAR(255);`);

    } catch (e) {
        console.warn('Database schema auto-fix warning (non-fatal):', e.message);
    }
};

router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Invalid session payload.' });

        // Run schema auto-fix first
        await ensureTablesExist();

        // Fetch User Data
        const userResult = await db.query('SELECT wallet_balance, trial_ends_at FROM users WHERE id = $1', [userId]);
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
            console.warn("History fetch warning:", historyErr.message);
        }

        // Fetch Dynamic Fee Tiers safely
        let subscriptionTiers = [
            { name: "0 - 15 Cases", monthly: 0 },
            { name: "16 - 30 Cases", monthly: 200 },
            { name: "31 - 50 Cases", monthly: 400 },
            { name: "51 - 100 Cases", monthly: 750 },
            { name: "101+ Cases", monthly: 1500 }
        ];

        try {
            const tierResult = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'subscription_tiers'");
            if (tierResult.rows.length > 0 && tierResult.rows[0].setting_value) {
                subscriptionTiers = JSON.parse(tierResult.rows[0].setting_value);
            } else {
                await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('subscription_tiers', $1)", [JSON.stringify(subscriptionTiers)]);
            }
        } catch (tierErr) {
            console.warn("Tier settings warning:", tierErr.message);
        }

        res.json({
            success: true,
            balance: userResult.rows[0].wallet_balance || 0,
            trial_ends_at: userResult.rows[0].trial_ends_at || new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString(),
            transactions: historyResult.rows,
            subscription_tiers: subscriptionTiers
        });
    } catch (error) {
        console.error('[WALLET API] Crash details:', error);
        // EXPOSE THE ERROR DIRECTLY TO FRONTEND SO WE CAN SEE IT
        res.status(500).json({
            success: false,
            message: 'Server error: ' + error.message,
            sqlState: error.code || 'unknown'
        });
    }
});

// GET /api/wallet/referral-stats - Fetch referral code and stats
router.get('/referral-stats', authenticateToken, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Invalid session payload.' });

        await ensureTablesExist();

        let referralCode = '';
        let totalReferred = 0;

        try {
            const userRes = await db.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
            if (userRes.rows.length > 0) referralCode = userRes.rows[0].referral_code;

            const countRes = await db.query('SELECT COUNT(*) as total_referred FROM users WHERE referred_by = $1', [String(userId)]);
            totalReferred = parseInt(countRes.rows[0].total_referred || 0);
        } catch (dbErr) {
            console.warn("Referral DB Error:", dbErr.message);
        }

        res.json({
            success: true,
            referral_code: referralCode,
            total_referred: totalReferred,
            shareable_link: `https://app.lawyer.trvnx.com/register?ref=${referralCode}`
        });

    } catch (error) {
        console.error('[REFERRAL API] Error fetching referral stats:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// POST /api/wallet/topup - Handle bKash/Nagad top-up simulation
router.post('/topup', authenticateToken, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Invalid session payload.' });

        const { amount, provider, trxId } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid top-up amount.' });
        }

        await ensureTablesExist();

        // 1. Update user wallet balance and push trial expiration forward by 30 days
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
        const result = await db.query(updateQuery, [amount, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        // 2. Log into wallet_transactions safely
        try {
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
            newBalance: result.rows[0].wallet_balance,
            trial_ends_at: result.rows[0].trial_ends_at
        });
    } catch (error) {
        console.error('[WALLET TOPUP] Error processing top-up:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// ✨ UPDATED: POST /verify-manual (Bulletproof version using standard db.query)
router.post('/verify-manual', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { senderNumber, amount, trxId, gateway } = req.body;

        if (!senderNumber || !amount || !trxId) {
            return res.status(400).json({ success: false, message: 'Please fill in all 3 fields.' });
        }

        const lawyerPhone = senderNumber.replace(/[^0-9]/g, '').slice(-11);
        const lawyerTrx = trxId.trim().toUpperCase();
        const lawyerAmount = parseFloat(amount);

        // Look for matching row where all 3 values align
        const queryText = `
            SELECT * FROM payment_webhooks
            WHERE transaction_id = $1
              AND amount = $2
              AND RIGHT(sender_number, 11) = $3
              AND status = 'WAITING FOR REQ'
        `;
        const result = await db.query(queryText, [lawyerTrx, lawyerAmount, lawyerPhone]);

        if (result.rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No matching unverified payment found. Verify the TrxID, sending number, and exact amount, or wait a minute if your payment was just completed.'
            });
        }

        const webhookRow = result.rows[0];

        // 1. Mark webhook as SUCCESS
        await db.query(
            `UPDATE payment_webhooks
             SET status = 'SUCCESS', claimed_by_user_id = $1, claimed_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [userId, webhookRow.id]
        );

        // 2. Credit the lawyer's wallet balance initially
        await db.query(`UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2`, [lawyerAmount, userId]);

        // 3. Insert top-up transaction ledger record
        await db.query(
            `INSERT INTO wallet_transactions (user_id, amount, transaction_type, description) VALUES ($1, $2, 'TOP_UP', $3)`,
            [String(userId), lawyerAmount, `${gateway || 'bKash'} Top-Up (TrxID: ${lawyerTrx})`]
        );

        // ==========================================
        // 4. AUTO-RECOVERY ENGINE
        // ==========================================
        const userCheck = await db.query(`SELECT wallet_balance, trial_ends_at FROM users WHERE id = $1`, [userId]);
        const user = userCheck.rows[0];

        // If their account was expired, check if they now have enough to pay their pending subscription
        if (new Date(user.trial_ends_at) <= new Date()) {
            const clientCountRes = await db.query(`SELECT COUNT(DISTINCT client_phone) as total_clients FROM cases WHERE user_id = $1 AND is_closed = false`, [userId]);
            const clientCount = parseInt(clientCountRes.rows[0].total_clients);

            let amountDue = 0;
            let tierName = "Free Tier";
            if (clientCount >= 6 && clientCount <= 50) { amountDue = 30.00; tierName = "Standard Tier (6-50 Clients)"; }
            else if (clientCount > 50) { amountDue = 60.00; tierName = "Pro Tier (51+ Clients)"; }

            // If they owe money and their new balance covers it, deduct it instantly and unlock the account!
            if (amountDue > 0 && user.wallet_balance >= amountDue) {
                await db.query(`
                    UPDATE users
                    SET wallet_balance = wallet_balance - $1,
                        trial_ends_at = NOW() + INTERVAL '1 month'
                    WHERE id = $2
                `, [amountDue, userId]);

                await db.query(`
                    INSERT INTO wallet_transactions (user_id, amount, transaction_type, description)
                    VALUES ($1, $2, 'SUBSCRIPTION_FEE', $3)
                `, [String(userId), -amountDue, `Account Auto-Recovery: ${tierName}`]);
            } else if (amountDue === 0) {
                // If they are free tier but somehow expired, unlock them for free
                await db.query(`UPDATE users SET trial_ends_at = NOW() + INTERVAL '1 month' WHERE id = $1`, [userId]);
            }
        }

        return res.json({
            success: true,
            message: `৳${lawyerAmount} credited successfully to your wallet balance.`
        });

    } catch (err) {
        console.error('verify-manual error:', err);
        return res.status(500).json({ success: false, message: 'Transaction failed: ' + err.message });
    }
});

// Add this temporarily at the bottom of walletRoutes.js to fix old records
router.get('/fix-ledger', async (req, res) => {
    try {
        await db.query(`UPDATE wallet_transactions SET transaction_type = 'TOP_UP' WHERE transaction_type = 'TOPUP'`);
        res.json({ success: true, message: "Old records fixed! You can now refresh your Admin Dashboard." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;