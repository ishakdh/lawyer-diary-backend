const cron = require('node-cron');
const db = require('../config/db');

// Runs every day at 4:00 PM (16:00)
cron.schedule('0 16 * * *', async () => {
    console.log('[CRON] Starting daily 2-day advance case scan...');

    try {
        const query = `
            SELECT c.*, u.full_name AS lawyer_name
            FROM cases c
                     JOIN users u ON c.chamber_owner_id = u.id
            WHERE DATE(c.next_hearing_date) = CURRENT_DATE + INTERVAL '2 days'
        `;

        const result = await db.query(query);
        const upcomingCases = result.rows;

        if (upcomingCases.length === 0) {
            console.log('[CRON] No hearings scheduled for 2 days from now. Job finished.');
            return;
        }

        console.log(`[CRON] Found ${upcomingCases.length} upcoming hearings. Generating lawyer notifications...`);

        for (const caseItem of upcomingCases) {
            const phone = caseItem.client_phone;
            if (!phone) continue;

            // Here, instead of the system sending a paid message to the client,
            // the system can either send a single daily summary email/notification to the LAWYER,
            // or simply prepare the dashboard so the lawyer can click "Remind" on their own phone.

            console.log(`[SYSTEM] Case ${caseItem.case_number} flagged for reminder. Lawyer will send manually via own WhatsApp/SMS.`);
        }

        console.log('[CRON] Daily case scan complete.');

    } catch (error) {
        console.error('[CRON] Error scanning cases:', error);
    }
});