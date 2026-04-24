module.exports = {
    checkAuth: (req, res, next) => {
        if (req.isAuthenticated()) return next();
        res.redirect('/');
    }
};