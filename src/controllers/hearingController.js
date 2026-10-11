// src/controllers/hearingController.js
const db = require('../config/db');

const addHearingLog = async (req, res) => {
    const { case_id, hearing_date, notes, next_hearing_date, court_order = 'Awaiting Order' } = req.body;
    const chamberOwnerId = req.user.id;

    try {
        // 1. Security Check
        const caseCheck = await db.query(
            'SELECT id FROM cases WHERE id = $1 AND chamber_owner_id = $2',
            [case_id, chamberOwnerId]
        );

        if (caseCheck.rows.length === 0) {
            return res.status(403).json({ success: false, error: 'Not authorized to update this case' });
        }

        // 2. Insert hearing update with next_date and court_order included
        await db.query(
            `INSERT INTO hearing_logs (case_id, logged_by, hearing_date, notes, court_order, next_date)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [case_id, chamberOwnerId, hearing_date, notes, court_order, next_hearing_date]
        );

        // 3. Automatically update the main case's next hearing date
        if (next_hearing_date) {
            await db.query(
                'UPDATE cases SET next_hearing_date = $1 WHERE id = $2',
                [next_hearing_date, case_id]
            );
        }

        res.status(201).json({ success: true, message: 'Hearing logged and calendar updated' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Failed to add hearing log' });
    }
};

const getHearingsByCase = async (req, res) => {
    const { case_id } = req.params; // Extract the case ID from the URL
    const chamberOwnerId = req.user.id;

    try {
        // 1. Security Check: Ensure the lawyer actually owns this case before showing logs
        const caseCheck = await db.query(
            'SELECT id FROM cases WHERE id = $1 AND chamber_owner_id = $2',
            [case_id, chamberOwnerId]
        );

        if (caseCheck.rows.length === 0) {
            return res.status(403).json({ success: false, error: 'Not authorized to view this case' });
        }

        // 2. Fetch the logs ordered from newest to oldest
        const logs = await db.query(
            `SELECT id, hearing_date, notes, court_order, next_date 
             FROM hearing_logs 
             WHERE case_id = $1 
             ORDER BY hearing_date DESC`,
            [case_id]
        );

        res.status(200).json({
            success: true,
            count: logs.rows.length,
            logs: logs.rows
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Failed to fetch hearing logs' });
    }
};

module.exports = { addHearingLog, getHearingsByCase };