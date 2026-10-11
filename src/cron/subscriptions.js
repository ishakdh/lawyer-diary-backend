const cron = require('node-cron');
const db = require('../config/db');

// Runs every night at exactly midnight (00:00)
cron.schedule('0 0 * * *', async () => {
    console.log('[BILLING ENGINE] Starting midnight subscription processing...');

    try {
        // 1. Find all users whose trial or current billing month has ended
        const expiredUsersRes = await db.query(`
            SELECT id, full_name, wallet_balance, trial_ends_at 
            FROM users 
            WHERE trial_ends_at <= CURRENT_TIMESTAMP
        `);

        const usersToBill = expiredUsersRes.rows;

        if (usersToBill.length === 0) {
            console.log('[BILLING ENGINE] No subscriptions due today.');
            return;
        }

        // 2. Fetch the latest pricing tiers set by the Master Admin
        const tiersRes = await db.query('SELECT * FROM subscription_tiers ORDER BY min_clients ASC');
        const tiers = tiersRes.rows;

        for (const user of usersToBill) {
            // 3. Count how many unique clients this lawyer has active right now
            const clientCountRes = await db.query(`
                SELECT COUNT(DISTINCT client_phone) as total_clients 
                FROM cases 
                WHERE chamber_owner_id = $1
            `, [user.id]);

            const clientCount = parseInt(clientCountRes.rows[0].total_clients);

            // 4. Determine their correct pricing tier based on client count
            let matchedTier = tiers[tiers.length - 1]; // Default to highest tier just in case
            for (const tier of tiers) {
                if (clientCount >= tier.min_clients && (tier.max_clients === null || clientCount <= tier.max_clients)) {
                    matchedTier = tier;
                    break;
                }
            }

            // 5. Process the Payment
            const amountDue = parseFloat(matchedTier.monthly_price);

            console.log(`[BILLING] Lawyer ${user.full_name} has ${clientCount} clients. Tier: ${matchedTier.tier_name} (৳${amountDue})`);

            if (user.wallet_balance >= amountDue) {
                // Deduct money and extend their access by exactly 1 month
                await db.query(`
                    UPDATE users 
                    SET wallet_balance = wallet_balance - $1, 
                        trial_ends_at = trial_ends_at + INTERVAL '1 month' 
                    WHERE id = $2
                `, [amountDue, user.id]);

                // Log the payment in the wallet ledger
                if (amountDue > 0) {
                    await db.query(`
                        INSERT INTO wallet_transactions (user_id, amount, transaction_type, description) 
                        VALUES ($1, $2, 'USAGE_DEDUCTION', $3)
                    `, [user.id, amountDue, `Monthly Subscription: ${matchedTier.tier_name} Tier`]);
                }

                console.log(`[BILLING] SUCCESS: Deducted ৳${amountDue} from ${user.full_name}. Access extended for 1 month.`);
            } else {
                // Insufficient funds - they stay expired.
                console.log(`[BILLING] FAILED: ${user.full_name} has insufficient funds (Balance: ৳${user.wallet_balance}, Needed: ৳${amountDue}).`);
            }
        }

        console.log('[BILLING ENGINE] Midnight processing complete.');

    } catch (error) {
        console.error('[BILLING ENGINE] Error processing subscriptions:', error);
    }
});