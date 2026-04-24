/**
 * ルーティング関連のAPIエンドポイント
 */
const express = require('express');
const router = express.Router();
const engineSelector = require('../../utils/engineSelector');

// ミドルウェア: APIキー認証（Layer-C用）
const checkApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    const expectedKey = process.env.TTS_WORKER_KEY;

    if (expectedKey && apiKey !== expectedKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

/**
 * GET /api/routing/stats
 * 全ワーカーの割り当て状況を返す
 */
router.get('/stats', checkApiKey, (req, res) => {
    const stats = engineSelector.getRoutingStats();
    res.json({ status: 'ok', workers: stats });
});

/**
 * GET /api/routing/worker/:workerUrl/characters
 * 特定ワーカーに割り当てられたキャラクターIDリストを返す
 * workerUrl は URL エンコードされている想定
 */
router.get('/worker/:workerUrl/characters', checkApiKey, (req, res) => {
    const workerUrl = decodeURIComponent(req.params.workerUrl);
    const characters = engineSelector.getWorkerCharacters(workerUrl);

    res.json({
        status: 'ok',
        workerUrl,
        characters,
        count: characters.length
    });
});

/**
 * GET /api/routing/worker-by-index/:index/characters
 * インデックスでワーカーを指定してキャラクターIDリストを返す（URL扱いが難しい場合用）
 */
router.get('/worker-by-index/:index/characters', checkApiKey, (req, res) => {
    const index = parseInt(req.params.index, 10);
    const stats = engineSelector.getRoutingStats();

    if (index < 0 || index >= stats.length) {
        return res.status(404).json({ error: 'Worker not found' });
    }

    const worker = stats[index];
    res.json({
        status: 'ok',
        workerUrl: worker.url,
        characters: worker.assignedCharacters,
        count: worker.assignedCount
    });
});

module.exports = router;
