const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authenticateToken = require('../middleware/auth');

// 1. WEBHOOK: Receives incoming SMS from your Android Phone
// URL: POST /api/payment/webhook
router.post('/webhook', async (req, res) => {
    const { sms_body, sender } = req.body; // Sent by your Android SMS Forwarder app

    try {
        let gateway = '';
        let trxId = '';
        let amount = 0;
        let senderNumber = '';

        // Basic bKash SMS Parsing Logic
        if (sender.toLowerCase().includes('bkash')) {
            gateway = 'BKASH';
            // Regex to extract TrxID (usually 8-10 uppercase alphanumeric)
            const trxMatch = sms_body.match(/TrxID\s*([A-Z0-9]+)/i);
            // Regex to extract Amount (e.g., Tk 500.00 or BDT 500)
            const amountMatch = sms_body.match(/Tk\s*([\d,]+\.\d+)/i);

            if (trxMatch && amountMatch) {
                trxId = trxMatch[1].toUpperCase();
                amount = parseFloat(amountMatch[1].replace(/,/g, ''));
            }
        }
        // Basic Nagad SMS Parsing Logic
        else if (sender.toLowerCase().includes('nagad')) {
            gateway = 'NAGAD';
            const trxMatch = sms_body.match(/TxnID:\s*([A-Z0-9]+)/i);
            const amountMatch = sms_body.match(/Amount:\s*Tk\s*([\d,]+\.\d+)/i);

            if (trxMatch && amountMatch) {
                trxId = trxMatch[1].toUpperCase();
                amount = parseFloat(amountMatch[1].replace(/,/g, ''));
            }
        }

        // If we successfully parsed a TrxID and Amount, save it to the DB as WAITING
        if (trxId && amount > 0) {
            await db.query(`
                INSERT INTO gateway_transactions (trx_id, gateway, amount, sender_number, status) 
                VALUES ($1, $2, $3, $4, 'WAITING')
                ON CONFLICT (trx_id) DO NOTHING; -- Prevents duplicate SMS processing
            `, [trxId, gateway, amount, senderNumber]);

            console.log(`[PAYMENT GATEWAY] Logged new ${gateway} TrxID: ${trxId} for ৳${amount}`);
        }

        res.status(200).send('SMS Processed');
    } catch (error) {
        console.error('[PAYMENT GATEWAY] Webhook Error:', error);
        res.status(500).send('Server Error');
    }
});

// 2. USER CLAIM: Lawyer inputs TrxID on React Dashboard to top up wallet
// URL: POST /api/payment/claim
router.post('/claim', authenticateToken, async (req, res) => {
    const { trx_id } = req.body;
    const userId = req.user.id;
    const upperTrxId = trx_id.toUpperCase();

    try {
        // Find the transaction
        const txResult = await db.query('SELECT * FROM gateway_transactions WHERE trx_id = $1', [upperTrxId]);

        if (txResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Transaction ID not found. Please wait 1 minute for the SMS to sync and try again.' });
        }

        const tx = txResult.rows[0];

        if (tx.status === 'SUCCESS') {
            return res.status(400).json({ success: false, message: 'This Transaction ID has already been claimed.' });
        }

        // Start Database Transaction to ensure money is safely credited
        await db.query('BEGIN');

        // 1. Update the gateway transaction to SUCCESS
        await db.query(`
            UPDATE gateway_transactions 
            SET status = 'SUCCESS', claimed_by = $1 
            WHERE trx_id = $2
        `, [userId, upperTrxId]);

        // 2. Add money to the lawyer's wallet and extend trial if expired
        await db.query(`
            UPDATE users 
            SET wallet_balance = wallet_balance + $1,
                trial_ends_at = CASE 
                    WHEN trial_ends_at < CURRENT_TIMESTAMP THEN CURRENT_TIMESTAMP 
                    ELSE trial_ends_at 
                END
            WHERE id = $2
        `, [tx.amount, userId]);

        // 3. Log it in the wallet ledger
        await db.query(`
            INSERT INTO wallet_transactions (user_id, amount, transaction_type, description) 
            VALUES ($1, $2, 'TOP_UP', $3)
        `, [userId, tx.amount, `${tx.gateway} Top-Up (TrxID: ${upperTrxId})`]);

        await db.query('COMMIT');

        res.json({ success: true, message: `Successfully topped up ৳${tx.amount}`, amount: tx.amount });
    } catch (error) {
        await db.query('ROLLBACK');
        console.error('[PAYMENT GATEWAY] Claim Error:', error);
        res.status(500).json({ success: false, message: 'Server error processing payment.' });
    }
});

module.exports = router;