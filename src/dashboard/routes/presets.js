const express = require('express');
const router = express.Router({ mergeParams: true });
const { checkAuth } = require('../middleware/auth');
const { 
    getUserSettings, setUserSpeakerId, setUserSpeed, setUserPitch,
    addVoicePreset, getVoicePreset, deleteVoicePreset, updateVoicePreset
} = require('../../database');

module.exports = (client) => {
    router.post('/add', checkAuth, (req, res) => {
        const { guildId } = req.params;
        const userId = req.user.id;
        const { name } = req.body;

        if (!name) return res.redirect(`/dashboard/${guildId}`);

        const settings = getUserSettings(guildId, userId);
        addVoicePreset(userId, name, {
            speaker_id: settings.speaker_id || 1,
            speaker_type: settings.speaker_type || 'voicevox',
            speed: settings.speed || 1.0,
            pitch: settings.pitch || 0.0
        });
        res.redirect(`/dashboard/${guildId}`);
    });

    router.post('/update', checkAuth, (req, res) => {
        const { guildId } = req.params;
        const userId = req.user.id;
        const { presetId, name, speed, pitch, speakerSelection } = req.body;

        let newSettings = {
            speed: parseFloat(speed),
            pitch: parseFloat(pitch)
        };

        if (speakerSelection) {
            const [type, idStr] = speakerSelection.split('_');
            const speakerId = parseInt(idStr, 10);
            if (!isNaN(speakerId)) {
                newSettings.speaker_id = speakerId;
                newSettings.speaker_type = type;
            }
        }

        if (!name || isNaN(newSettings.speed) || isNaN(newSettings.pitch) || !newSettings.speaker_id) {
             return res.redirect(`/dashboard/${guildId}?error=${encodeURIComponent('無効な入力値です')}`);
        }

        updateVoicePreset(userId, presetId, name, newSettings);
        res.redirect(`/dashboard/${guildId}`);
    });

    router.post('/delete', checkAuth, (req, res) => {
        const { presetId } = req.body;
        deleteVoicePreset(presetId, req.user.id);
        res.redirect(`/dashboard/${req.params.guildId}`);
    });

    router.post('/load', checkAuth, (req, res) => {
        const { guildId } = req.params;
        const userId = req.user.id;
        const { presetId } = req.body;

        const preset = getVoicePreset(presetId);
        if (preset && preset.user_id === userId) {
            setUserSpeakerId(guildId, userId, preset.speaker_id, preset.speaker_type);
            setUserSpeed(guildId, userId, preset.speed);
            setUserPitch(guildId, userId, preset.pitch);

            const manager = client.guildVoiceManagers.get(guildId);
            if (manager && manager.isActive()) {
                manager.setSpeed(userId, preset.speed);
                manager.setPitch(userId, preset.pitch);
            }
        }
        res.redirect(`/dashboard/${guildId}`);
    });

    return router;
};