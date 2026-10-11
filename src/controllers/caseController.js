// src/controllers/caseController.js
const db = require('../config/db');

// Helper to format date to dd/mm/yyyy
const formatHearingDate = (date) => {
    if (!date) return 'No Date';
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
};

const cleanPhone = (phone) => {
    if (!phone) return null;
    let cleaned = phone.replace(/[^0-9]/g, '');
    if (cleaned.startsWith('0')) {
        cleaned = '88' + cleaned;
    }
    return cleaned;
};

// --- NEW HELPER: Auto-Diary Stamper ---
const getTodayPrefix = () => {
    return `[${new Date().toLocaleDateString('en-GB')}]`;
};

const appendNote = (existingNotes, newAddition) => {
    if (!newAddition) return existingNotes;
    return existingNotes ? `${existingNotes}\n${newAddition}` : newAddition;
};
// --------------------------------------

// 1. Create a new case
exports.createCase = async (req, res) => {
    try {
        const chamber_owner_id = req.user?.id || req.body.chamber_owner_id;
        const { case_number, section, court_name, client_name, client_phone, opponent_name, next_hearing_date, notes } = req.body;

        if (!case_number || !client_name || !client_phone) {
            return res.status(400).json({ success: false, message: 'Please provide all required fields.' });
        }

        // Auto-log case creation
        const creationLog = `${getTodayPrefix()} Case Created.`;
        const finalNotes = appendNote(creationLog, notes);

        const query = `
            INSERT INTO cases (chamber_owner_id, case_number, section, court_name, client_name, client_phone, opponent_name, next_hearing_date, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *;
        `;
        const values = [chamber_owner_id, case_number, section || null, court_name, client_name, cleanPhone(client_phone), opponent_name, next_hearing_date || null, finalNotes];
        const result = await db.query(query, values);
        const newCase = result.rows[0];

        if (chamber_owner_id) {
            await db.query(
                `INSERT INTO activity_logs (user_id, action_type, description) VALUES ($1, $2, $3);`,
                [chamber_owner_id, 'CASE_CREATED', `Created case number "${case_number}" for client "${client_name}"`]
            );
        }

        res.status(201).json({ success: true, case: newCase });
    } catch (error) {
        console.error('Error creating case:', error);
        res.status(500).json({ success: false, message: 'Server error while creating case.' });
    }
};

// 2. Get all cases
exports.getCases = async (req, res) => {
    try {
        const lawyerId = req.user.id;
        const lawyerRes = await db.query('SELECT full_name FROM users WHERE id = $1', [lawyerId]);
        const lawyerName = lawyerRes.rows.length > 0 ? lawyerRes.rows[0].full_name : 'Lawyer';

        const casesResult = await db.query(
            `SELECT * FROM cases WHERE chamber_owner_id = $1 ORDER BY is_closed ASC, next_hearing_date ASC NULLS LAST`,
            [lawyerId]
        );

        const casesWithLinks = casesResult.rows.map(caseItem => {
            const hearingDate = caseItem.next_hearing_date ? new Date(caseItem.next_hearing_date).toLocaleDateString('en-GB') : 'Not Scheduled';
            const phone = cleanPhone(caseItem.client_phone);
            const message = `Hello ${caseItem.client_name}, \n\nGreeting from "${lawyerName}" this is a reminder from your lawyer. Your case (${caseItem.case_number}) at ${caseItem.court_name || 'Court'} has a hearing scheduled on ${hearingDate}. Please be present on the schedule date at morning 9AM.`;
            const encodedMessage = encodeURIComponent(message);

            return {
                ...caseItem,
                whatsapp_link: `https://wa.me/${phone}?text=${encodedMessage}`
            };
        });

        res.status(200).json({ success: true, cases: casesWithLinks });
    } catch (error) {
        console.error('Error fetching cases:', error);
        res.status(500).json({ success: false, message: 'Server error while fetching cases.' });
    }
};

// 3. Get upcoming hearings
exports.getUpcomingHearings = async (req, res) => {
    try {
        const chamber_owner_id = req.user?.id || req.query.chamber_owner_id;
        const query = `
            SELECT c.*, u.full_name AS lawyer_name FROM cases c
                                                            JOIN users u ON c.chamber_owner_id = u.id
            WHERE c.chamber_owner_id = $1 AND c.is_closed = FALSE AND DATE(c.next_hearing_date) = CURRENT_DATE + INTERVAL '1 day'
            ORDER BY c.case_number ASC;
        `;
        const result = await db.query(query, [chamber_owner_id]);

        const casesWithLinks = result.rows.map((row) => {
            const formattedDate = formatHearingDate(row.next_hearing_date);
            const lawyerName = row.lawyer_name || 'Advocate';
            const phone = cleanPhone(row.client_phone);
            const reminderMessage = `Greeting from ${lawyerName}!\n\nYour next hearing for case ${row.case_number} is scheduled for ${formattedDate}. Please ensure timely attendance.`;
            const encodedMessage = encodeURIComponent(reminderMessage);

            return {
                ...row,
                formatted_hearing_date: formattedDate,
                message_text: reminderMessage,
                whatsapp_url: `https://wa.me/${phone}?text=${encodedMessage}`,
                sms_url: `sms:${phone}?body=${encodedMessage}`
            };
        });

        res.status(200).json({ success: true, total: casesWithLinks.length, cases: casesWithLinks });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error while fetching upcoming hearings.' });
    }
};

// 4. Complete Hearing (Auto-logs details & new dates)
exports.completeHearing = async (req, res) => {
    try {
        const { id } = req.params;
        const lawyerId = req.user?.id;
        const { hearing_note, next_hearing_date } = req.body;

        const caseRes = await db.query('SELECT * FROM cases WHERE id = $1', [id]);
        if (caseRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Case not found.' });

        const currentCase = caseRes.rows[0];

        // Format diary entry
        let actionNotes = [];
        if (hearing_note) actionNotes.push(`Hearing Details: ${hearing_note}`);
        if (next_hearing_date) actionNotes.push(`Next date scheduled for ${formatHearingDate(next_hearing_date)}`);

        let newDiaryEntry = null;
        if (actionNotes.length > 0) {
            newDiaryEntry = `${getTodayPrefix()} ${actionNotes.join(' | ')}`;
        } else {
            newDiaryEntry = `${getTodayPrefix()} Hearing completed without specific notes or next date.`;
        }

        const updatedNotes = appendNote(currentCase.notes, newDiaryEntry);
        const newDateVal = next_hearing_date ? next_hearing_date : null;

        const updateQuery = `
            UPDATE cases SET notes = $1, next_hearing_date = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *;
        `;
        const result = await db.query(updateQuery, [updatedNotes, newDateVal, id]);
        const updatedCase = result.rows[0];

        const ownerId = lawyerId || currentCase.chamber_owner_id;
        if (ownerId) {
            await db.query(
                `INSERT INTO activity_logs (user_id, action_type, description) VALUES ($1, $2, $3);`,
                [ownerId, 'HEARING_COMPLETED', `Completed hearing for case "${updatedCase.case_number}". Next date: ${newDateVal ? formatHearingDate(newDateVal) : 'Not assigned'}`]
            );
        }
        res.status(200).json({ success: true, case: updatedCase });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error while completing hearing.' });
    }
};

// 5. Transfer Case (Auto-logs old & new numbers)
exports.transferCase = async (req, res) => {
    try {
        const { id } = req.params;
        const lawyerId = req.user?.id;
        const { case_number, section, court_name } = req.body;

        if (!case_number) return res.status(400).json({ success: false, message: 'New case number is required.' });

        const oldCaseRes = await db.query('SELECT * FROM cases WHERE id = $1', [id]);
        if (oldCaseRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Case not found.' });
        const oldCase = oldCaseRes.rows[0];

        // Format diary entry
        const transferNote = `${getTodayPrefix()} Case Transferred from Old Case No. "${oldCase.case_number}" to New Case No. "${case_number}".`;
        const updatedNotes = appendNote(oldCase.notes, transferNote);

        const query = `
            UPDATE cases 
            SET old_case_number = case_number,
                old_court_name = court_name,
                old_section = section,
                case_number = $1,
                section = $2,
                court_name = $3,
                notes = $4,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $5
            RETURNING *;
        `;
        const result = await db.query(query, [case_number, section || null, court_name || null, updatedNotes, id]);
        const updatedCase = result.rows[0];

        const ownerId = lawyerId || oldCase.chamber_owner_id;
        if (ownerId) {
            await db.query(
                `INSERT INTO activity_logs (user_id, action_type, description) VALUES ($1, $2, $3);`,
                [ownerId, 'CASE_TRANSFERRED', `Transferred case from "${oldCase.case_number}" to "${case_number}"`]
            );
        }

        res.status(200).json({ success: true, case: updatedCase });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error while transferring case.' });
    }
};

// 6. Close / Re-Open Case (Auto-logs reason)
exports.toggleCloseCase = async (req, res) => {
    try {
        const { id } = req.params;
        const lawyerId = req.user?.id;
        const { close_reason } = req.body;

        const caseRes = await db.query('SELECT is_closed, case_number, chamber_owner_id, notes FROM cases WHERE id = $1', [id]);
        if (caseRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Case not found.' });

        const currentCase = caseRes.rows[0];
        const isCurrentlyClosed = currentCase.is_closed;

        let query, values, actionText;

        if (isCurrentlyClosed) {
            // Re-Open logic
            const reopenNote = `${getTodayPrefix()} Case Re-Opened.`;
            const updatedNotes = appendNote(currentCase.notes, reopenNote);

            query = `UPDATE cases SET is_closed = FALSE, close_reason = NULL, notes = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *;`;
            values = [updatedNotes, id];
            actionText = 'CASE_REOPENED';
        } else {
            // Close logic
            const closeNote = `${getTodayPrefix()} Case Closed. Reason: ${close_reason || 'No reason provided.'}`;
            const updatedNotes = appendNote(currentCase.notes, closeNote);

            query = `UPDATE cases SET is_closed = TRUE, close_reason = $1, notes = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *;`;
            values = [close_reason || 'No reason provided', updatedNotes, id];
            actionText = 'CASE_CLOSED';
        }

        const result = await db.query(query, values);

        const ownerId = lawyerId || currentCase.chamber_owner_id;
        if (ownerId) {
            await db.query(
                `INSERT INTO activity_logs (user_id, action_type, description) VALUES ($1, $2, $3);`,
                [ownerId, actionText, `${isCurrentlyClosed ? 'Re-opened' : 'Closed'} case "${currentCase.case_number}"`]
            );
        }

        res.status(200).json({ success: true, case: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error toggling close status.' });
    }
};

// 7. Update case details
exports.updateCase = async (req, res) => {
    try {
        const { id } = req.params;
        const { case_number, section, court_name, client_name, client_phone, opponent_name, next_hearing_date, current_status, notes } = req.body;

        const query = `
            UPDATE cases
            SET case_number = COALESCE($1, case_number),
                section = COALESCE($2, section),
                court_name = COALESCE($3, court_name),
                client_name = COALESCE($4, client_name),
                client_phone = COALESCE($5, client_phone),
                opponent_name = COALESCE($6, opponent_name),
                next_hearing_date = $7,
                current_status = COALESCE($8, current_status),
                notes = COALESCE($9, notes),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $10 RETURNING *;
        `;
        const values = [case_number, section, court_name, client_name, client_phone ? cleanPhone(client_phone) : null, opponent_name, next_hearing_date || null, current_status, notes, id];
        const result = await db.query(query, values);

        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Case not found.' });
        res.status(200).json({ success: true, case: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error while updating case.' });
    }
};

// 8. Delete a case
exports.deleteCase = async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query('DELETE FROM cases WHERE id = $1 RETURNING id;', [id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Case not found.' });
        res.status(200).json({ success: true, message: 'Case removed successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error while deleting case.' });
    }
};