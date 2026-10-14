const cron = require('node-cron');
const db = require('../config/db');

// Runs every night at exactly 00:01
cron.schedule('1 0 * * *', async () => {
    console.log('[BILLING ENGINE] Starting midnight subscription processing...');

    try {
        // ==========================================
        // TASK 1: Send 2-Day Warning Notifications
        // ==========================================
        const warningRes = await db.query(`
            SELECT id, full_name 
            FROM users 
            WHERE DATE(trial_ends_at) = CURRENT_DATE + INTERVAL '2 days'
        `);

        for (const user of warningRes.rows) {
            // Insert notification (Ensure your notifications table matches this structure)
            try {
                await db.query(`
                    INSERT INTO notifications (user_id, title, message, type)
                    VALUES ($1, $2, $3, 'WARNING')
                `, [
                    user.id,
                    'Subscription Expiring Soon',
                    `Your subscription plan will expire in 2 days. Please ensure you have at least ৳30 in your available balance to continue services seamlessly.`
                ]);
                console.log(`[BILLING] Sent 2-day warning to ${user.full_name}`);
            } catch (err) {
                console.warn(`[BILLING] Could not send notification to ${user.full_name}. Ensure notifications table exists.`);
            }
        }

        // ==========================================
        // TASK 2: Process Expired Subscriptions
        // ==========================================
        const expiredUsersRes = await db.query(`
            SELECT id, full_name, wallet_balance, trial_ends_at 
            FROM users 
            WHERE trial_ends_at <= CURRENT_TIMESTAMP
        `);

        for (const user of expiredUsersRes.rows) {
            // Count UNIQUE clients where the case is NOT closed
            // Note: If your cases table uses 'chamber_owner_id' instead of 'user_id', change it below.
            const clientCountRes = await db.query(`
                SELECT COUNT(DISTINCT client_phone) as total_clients
                FROM cases
                WHERE user_id = $1 AND is_closed = false
            `, [user.id]);

            const clientCount = parseInt(clientCountRes.rows[0].total_clients);

            // Tier Pricing Logic
            let amountDue = 0;
            let tierName = "Free Tier (0-5 Clients)";

            if (clientCount >= 6 && clientCount <= 50) {
                amountDue = 30.00;
                tierName = "Standard Tier (6-50 Clients)";
            } else if (clientCount > 50) {
                amountDue = 60.00; // Example for 51+ clients, adjust as needed
                tierName = "Pro Tier (51+ Clients)";
            }

            if (amountDue === 0) {
                // FREE TIER: Auto-extend for 1 month at no cost
                await db.query(`UPDATE users SET trial_ends_at = trial_ends_at + INTERVAL '1 month' WHERE id = $1`, [user.id]);
                console.log(`[BILLING] ${user.full_name} has ${clientCount} clients (Free Tier). Auto-extended 1 month.`);
            } else {
                // PAID TIER: Check wallet balance
                if (user.wallet_balance >= amountDue) {
                    // Deduct money and extend validity
                    await db.query(`
                        UPDATE users 
                        SET wallet_balance = wallet_balance - $1, 
                            trial_ends_at = trial_ends_at + INTERVAL '1 month' 
                        WHERE id = $2
                    `, [amountDue, user.id]);

                    // Log the deduction as an expense in the ledger
                    await db.query(`
                        INSERT INTO wallet_transactions (user_id, amount, transaction_type, description) 
                        VALUES ($1, $2, 'SUBSCRIPTION_FEE', $3)
                    `, [String(user.id), -amountDue, `Monthly Subscription Auto-Renewal: ${tierName}`]);

                    console.log(`[BILLING] SUCCESS: Deducted ৳${amountDue} from ${user.full_name}. Extended 1 month.`);
                } else {
                    // Insufficient funds: Leave them expired (Frontend will lock them out automatically)
                    console.log(`[BILLING] FAILED: ${user.full_name} has insufficient funds (Balance: ৳${user.wallet_balance}, Needed: ৳${amountDue}). Account Locked.`);
                }
            }
        }
        console.log('[BILLING ENGINE] Midnight processing complete.');
    } catch (error) {
        console.error('[BILLING ENGINE] Error processing subscriptions:', error);
    }
});