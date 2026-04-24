'use strict';

function parseLayerDBaseUrls(raw) {
    const urls = String(raw)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    return urls.length > 0 ? urls : [];
}

module.exports = { parseLayerDBaseUrls };
