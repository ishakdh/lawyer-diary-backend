const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authenticateToken = require('../middleware/auth');

// 0. FETCH PAYMENT GATEWAYS FOR LAWYER TOP UP
router.get('/gateways', authenticateToken, async (req, res) => {
    // ... (Keep your existing gateways code here)
    try {
        const result = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'payment_gateways'");
        let gateways = [];
        if (result.rows.length > 0 && result.rows[0].setting_value) gateways = JSON.parse(result.rows[0].setting_value);
        res.json({ success: true, gateways });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load payment gateways.' });
    }
});

// ✨ NEW: POST /sync-sms (Webhook from Android SMS Reader)
router.post('/sync-sms', async (req, res) => {
    try {
        const { secret_key, senderNumber, trxId, amount, gateway } = req.body;

        if (secret_key !== 'Raihan@!1611') {
            return res.status(403).json({ success: false, message: 'Invalid secret key' });
        }

        if (!trxId || !amount || !senderNumber) {
            return res.status(400).json({ success: false, message: 'Missing parameters' });
        }

        const cleanPhone = senderNumber.replace(/[^0-9]/g, '').slice(-11);
        const cleanTrx = trxId.trim().toUpperCase();
        const numAmount = parseFloat(amount);

        // Insert log with initial 'WAITING FOR REQ' status
        await db.query(
            `INSERT INTO payment_webhooks (sender_number, transaction_id, gateway, amount, status)
             VALUES ($1, $2, $3, $4, 'WAITING FOR REQ')
             ON CONFLICT (transaction_id) DO NOTHING`,
            [cleanPhone, cleanTrx, gateway || 'bKash', numAmount]
        );

        return res.json({ success: true, message: 'SMS received and stored in queue' });
    } catch (err) {
        console.error('sync-sms error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});



module.exports = router;