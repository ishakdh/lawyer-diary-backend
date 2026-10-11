// src/controllers/notificationController.js
const db = require('../config/db');

const sendClientNotification = async (req, res) => {
    const { case_id, client_phone, message } = req.body;
    const chamberOwnerId = req.user.id;
    const messageCost = 2.00; // Deduct 2 credits per message

    try {
        // 1. Check if the wallet has enough funds
        const walletResult = await db.query(
            'SELECT balance FROM wallets WHERE chamber_owner_id = $1',
            [chamberOwnerId]
        );

        if (walletResult.rows.length === 0 || walletResult.rows[0].balance < messageCost) {
            return res.status(402).json({
                success: false,
                error: 'Insufficient wallet balance. Please recharge.'
            });
        }

        // 2. Deduct the cost from the wallet
        const updatedWallet = await db.query(
            'UPDATE wallets SET balance = balance - $1 WHERE chamber_owner_id = $2 RETURNING balance',
            [messageCost, chamberOwnerId]
        );

        // 3. Simulate sending the actual WhatsApp/SMS Message (We will log it to the console for now)
        console.log('\n=== WHATSAPP MESSAGE DISPATCHED ===');
        console.log(`To: ${client_phone}`);
        console.log(`Message: ${message}`);
        console.log('===================================\n');

        // 4. Return success and the new balance to the app
        res.status(200).json({
            success: true,
            message: 'Notification sent successfully',
            cost: messageCost,
            remaining_balance: updatedWallet.rows[0].balance
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Failed to send notification' });
    }
};

module.exports = { sendClientNotification };