// src/routes/notificationRoutes.js
const express = require('express');
const router = express.Router();
const { sendClientNotification } = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

// Send a message and deduct balance (POST)
router.post('/send', protect, sendClientNotification);

module.exports = router;