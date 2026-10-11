const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authenticateToken = require('../middleware/auth');

router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // Fetch User Data
        const userResult = await db.query('SELECT wallet_balance, trial_ends_at FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

        // Fetch Transaction History
        const historyResult = await db.query(
            'SELECT amount, transaction_type, description, created_at FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
            [userId]
        );

        // Fetch Dynamic Fee Tiers from system_settings
        const tierResult = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'subscription_tiers'");
        let subscriptionTiers = [];
        if (tierResult.rows.length > 0) {
            try { subscriptionTiers = JSON.parse(tierResult.rows[0].setting_value); } catch(e){}
        }

        res.json({
            success: true,
            balance: userResult.rows[0].wallet_balance,
            trial_ends_at: userResult.rows[0].trial_ends_at,
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

        // Fetch user's referral code
        const userRes = await db.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const referralCode = userRes.rows.length > 0 ? userRes.rows[0].referral_code : '';

        // Count how many users registered using this user's ID as referred_by
        const countRes = await db.query('SELECT COUNT(*) as total_referred FROM users WHERE referred_by = $1', [userId]);
        const totalReferred = parseInt(countRes.rows[0].total_referred);

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

        // 1. Update user wallet balance and push trial expiration forward by 30 days if expired
        const updateQuery = `
            UPDATE users 
            SET wallet_balance = wallet_balance + $1,
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

        // 2. Optionally log into wallet_transactions if table exists
        try {
            await db.query(
                `INSERT INTO wallet_transactions (user_id, amount, transaction_type, description) VALUES ($1, $2, $3, $4)`,
                [userId, amount, 'TOPUP', `Top-up via ${provider} (TrxID: ${trxId || 'SIM'})`]
            );
        } catch (logErr) {
            // Non-blocking if table structure differs
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
        res.status(500).json({ success: false, message: 'Server error processing top-up.' });
    }
});

module.exports = router;