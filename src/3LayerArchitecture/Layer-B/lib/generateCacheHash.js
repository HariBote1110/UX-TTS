'use strict';

const crypto = require('crypto');

function generateCacheHash(text, speakerId, speed, pitch) {
    return crypto.createHash('md5').update(`${text}:${speakerId}:${speed}:${pitch}`).digest('hex');
}

module.exports = { generateCacheHash };
