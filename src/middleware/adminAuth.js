module.exports = (req, res, next) => {
    // Check if the user attached by authenticateToken is flagged as admin
    if (req.user && req.user.is_admin === true) {
        return next();
    }
    return res.status(403).json({
        success: false,
        message: 'Access denied. Master admin privileges required.'
    });
};