const { createAudioResource, StreamType } = require('@discordjs/voice');
const { Readable } = require('stream');
const { getAudioResource } = require('../audioCache'); 
const { sendErrorLog } = require('../errorLogger');

const OPENJTALK_API_URL = process.env.OPENJTALK_API_URL;

/**
 * テキストと設定に基づいて音声リソースを生成する
 * @param {string} text 読み上げテキスト
 * @param {object} options 設定オプション (userId, guildId, client, useOjt, speakerId, speed, pitch)
 * @returns {Promise<AudioResource|null>} 音声リソース
 */
async function synthesize(text, options) {
    const { client, guildId, useOjt, speakerId, speed, pitch } = options;
    let resource = null;
    let errorMessage = '';

    if (useOjt) {
        // --- Open JTalk ---
        if (!OPENJTALK_API_URL) return null;
        try {
            const response = await fetch(OPENJTALK_API_URL, { 
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ text })
            });
            if (!response.ok) throw new Error(`API Error: ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            const stream = Readable.from(Buffer.from(arrayBuffer));
            resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
        } catch (e) {
            errorMessage = `Open JTalk Error: ${e.message}`;
            sendErrorLog(client, e, { place: 'Synthesizer (OJT)', guildId });
        }
    } else {
        // --- VOICEVOX ---
        try {
            resource = await getAudioResource(text, speakerId, speed, pitch);
        } catch (e) {
             errorMessage = `VOICEVOX Error: ${e.message}`;
             sendErrorLog(client, e, { place: 'Synthesizer (VOICEVOX)', guildId });
        }
        if (!resource && !errorMessage) errorMessage = `VOICEVOX resource failed: ${text}`;
    }

    if (errorMessage) console.error(`[${guildId}] ${errorMessage}`);
    return resource;
}

module.exports = { synthesize };