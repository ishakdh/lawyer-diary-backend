// src/routes/hearingRoutes.js
const express = require('express');
const router = express.Router();
const { addHearingLog, getHearingsByCase } = require('../controllers/hearingController');
const { protect } = require('../middleware/authMiddleware');

// Add a new hearing log
router.post('/add', protect, addHearingLog);

// Get all hearing logs for a specific case
router.get('/:case_id', protect, getHearingsByCase);

module.exports = router;