const express = require('express');
const router = express.Router();
const caseController = require('../controllers/caseController');
const { protect } = require('../middleware/authMiddleware');

router.get('/upcoming', protect, caseController.getUpcomingHearings);
router.post('/', protect, caseController.createCase);
router.get('/', protect, caseController.getCases);
router.put('/:id/hearing', protect, caseController.completeHearing);
router.put('/:id/transfer', protect, caseController.transferCase);
router.patch('/:id/toggle-close', protect, caseController.toggleCloseCase);

// Specific sub-route MUST come before general /:id route
router.put('/:id/notes', protect, caseController.updateCaseNotes);

router.put('/:id', protect, caseController.updateCase);
router.delete('/:id', protect, caseController.deleteCase);

module.exports = router;