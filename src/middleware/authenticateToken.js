const jwt = require('jsonwebtoken');
const db = require('../config/db');

const authenticateToken = async (req, res, next) => {
    // 1. Get the token from the request header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer <token>"

    if (!token) {
        return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
    }

    try {
        // 2. Verify the token using the exact same secret key as your authRoutes
        const verified = jwt.verify(token, process.env.JWT_SECRET);

        // 3. Fetch fresh user details from DB to ensure accurate is_admin status
        const userQuery = await db.query('SELECT id, is_admin FROM users WHERE id = $1', [verified.id]);

        if (userQuery.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'User no longer exists.' });
        }

        // 4. Attach full user payload including fresh is_admin status
        req.user = {
            id: verified.id,
            is_admin: userQuery.rows[0].is_admin
        };

        next();

    } catch (error) {
        console.error('[AUTH ERROR]', error);
        res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    }
};

module.exports = authenticateToken;