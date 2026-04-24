const express = require('express');

module.exports = () => {
    const router = express.Router();

    router.get('/', (req, res) => {
        res.render('index', {
            user: req.user || null,
        });
    });

    return router;
};
