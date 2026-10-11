// src/controllers/walletController.js
const db = require('../config/db');

// 1. Get the current wallet balance
const getBalance = async (req, res) => {
    const chamberOwnerId = req.user.id;

    try {
        const result = await db.query(
            'SELECT balance FROM wallets WHERE chamber_owner_id = $1',
            [chamberOwnerId]
        );

        const balance = result.rows.length > 0 ? result.rows[0].balance : 0.00;
        res.status(200).json({ success: true, balance });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Failed to fetch wallet balance' });
    }
};

// 2. Add funds to the wallet
const rechargeWallet = async (req, res) => {
    const chamberOwnerId = req.user.id;
    const { amount } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid recharge amount' });
    }

    try {
        // Check if the lawyer already has a wallet row
        const checkWallet = await db.query('SELECT id FROM wallets WHERE chamber_owner_id = $1', [chamberOwnerId]);

        let newBalance;
        if (checkWallet.rows.length === 0) {
            // Create a new wallet with the initial amount
            const insertResult = await db.query(
                'INSERT INTO wallets (chamber_owner_id, balance) VALUES ($1, $2) RETURNING balance',
                [chamberOwnerId, amount]
            );
            newBalance = insertResult.rows[0].balance;
        } else {
            // Update the existing wallet by adding the amount
            const updateResult = await db.query(
                'UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE chamber_owner_id = $2 RETURNING balance',
                [amount, chamberOwnerId]
            );
            newBalance = updateResult.rows[0].balance;
        }

        res.status(200).json({ success: true, message: 'Wallet recharged successfully', balance: newBalance });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Failed to recharge wallet' });
    }
};

module.exports = { getBalance, rechargeWallet };